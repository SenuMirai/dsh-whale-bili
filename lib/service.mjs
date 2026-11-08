// 刷B站（fishman）的主服务层。
//
// 2026-11-08：日记、信、信笺、日子已经搬去世界插件（世界是记忆中心）。
// 这里剩下的只有「刷」——取稿、候选、决定、写入开关，以及活动账本。
//
// 它把两条线接在一起：
//   ① 「过日子」—— 会自己醒来、会记得昨天、会想跟主人说话（来自养鱼）
//   ② 「理解人」—— 诚实取稿、可修正的记忆、允许没有新发现（来自 humanism）
//
// 三条硬规矩（这是这次整合的立场，写在代码里而不是文档里）：
//   1. **没有新发现是合法结果** —— 任何工具都不因为"今天没产出"而报错
//   2. **读取永远不需要授权** —— 只有对外写入才要，而写入默认全关
//   3. **账本坏了就停** —— 不悄悄重建空账本（那样等于把她的日子清空）

import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { shDate } from "./clock.mjs";
import { Store } from "./store.mjs";
import { Budget } from "./budget.mjs";
import { Network } from "./network.mjs";
import { readVideo, coverage, segments } from "./reader.mjs";
import { need, safeError } from "./errors.mjs";
import { personality } from "./personality.mjs";
import { fields, exportInbox, readInbox, verifyInbox } from "./inbox.mjs";
import {
  enforceJournalDailyLimit,
  journalDailyStatus,
} from "./journal-policy.mjs";
import * as encounters from "./encounter.mjs";
import * as letters from "./letters.mjs";
import * as overrides from "./overrides.mjs";
import * as models from "./models.mjs";
import * as comments from "./comments.mjs";
import * as listen from "./listen.mjs";
import * as activity from "./activity.mjs";
import { Diary } from "./diary.mjs";
import * as videoTaste from "./video-taste.mjs";
import { Writer, grant as platformGrant, writeStatus, confirmConsumption } from "./writer.mjs";
import { Talker, talkStatus, grant as talkGrant } from "./talk.mjs";

const defaultLimits = {
  requests: 12,
  candidates: 3,
  asrSeconds: 600,
  wallMs: 90000,
};

/** 上海时区的今天（YYYY-MM-DD）。额度按这个日期归零 —— 不是 UTC 日 ✓ */
const shToday = () => shDate();
/** ISO 时间戳；存"什么时候报过"用，给人看的格式交给 UI */
const nowIso = () => new Date().toISOString();

/**
 * 写入接口用的是**复数**（comments / likes / favorites），
 * 活动账本用的是**单数**（comment / like / favorite）。
 *
 * ⚠️ 2026-10-22 踩的坑：直接把 `kind` 传给 activity.record 会被 KINDS 白名单拒掉，
 *   表现就是"评论明明发出去了，活动账本里没有"✗ —— 那正是主人抱怨"看不到"的原因。
 *   这个映射必须显式写出来，别指望两边命名一致 ✓
 */
const ACTIVITY_KIND = {
  comments: "comment",
  danmaku: "danmaku",
  dynamics: "dynamic",
  history: "history",
  favorites: "favorite",
  likes: "like",
  coins: "coin",
};

export function text(value, max = 12000) {
  need(typeof value === "string" && value.length <= max, "INVALID_TEXT");
  return value.trim();
}

// 段落字段可能是字符串，也可能是字符串数组（文档里 facts 常写成列表）。
// 数组压成一行一条，交给 text() 统一校验；其它类型保持原样让 text() 拒掉。
function fieldText(value) {
  if (Array.isArray(value)) {
    need(
      value.every((v) => typeof v === "string"),
      "INVALID_TEXT",
    );
    return value.join("\n");
  }
  return value;
}

export function noteBody(raw, reading) {
  need(raw && typeof raw === "object" && !Array.isArray(raw), "INVALID_NOTE");
  need(
    Object.keys(raw).every((k) => fields.includes(k) || k === "evidence"),
    "INVALID_NOTE_FIELD",
  );
  const body = Object.fromEntries(
    fields.map((k) => [k, text(fieldText(raw[k] ?? "") || "")]),
  );
  need(body.encounter && body.missing, "NOTE_REQUIRES_ENCOUNTER_AND_LIMITS");
  need(
    Array.isArray(raw.evidence) && raw.evidence.length <= 20,
    "INVALID_EVIDENCE",
  );
  body.evidence = raw.evidence.map((e) => {
    need(
      Number.isFinite(e.at) && e.at >= 0 && e.at <= reading.duration,
      "INVALID_EVIDENCE_TIME",
    );
    return {
      at: e.at,
      claim: text(e.claim, 2000),
      url: reading.url + "&t=" + Math.floor(e.at),
    };
  });
  if (body.facts || body.author_view)
    need(body.evidence.length > 0, "EVIDENCE_REQUIRED");
  return body;
}

export class Service {
  constructor(config = {}, dependencies = {}) {
    this.config = {
      ...config,
      enablePersonalityLearning:
        config.enablePersonalityLearning === undefined
          ? true
          : config.enablePersonalityLearning,
    };
    this.store = new Store(
      config.dataDir ||
        join(process.env.DSH_HOME || join(homedir(), ".dsh"), "bili-fishman"),
    );
    // 设置覆盖层：UI 改的东西落在这里，覆盖 cordis 配置里的同一批键 ✓
    this.settingsPath = overrides.settingsPath(this.store.root);
    this.baseConfig = { ...config };

    // ⚠️ 2026-10-25 修的**失能** bug：
    //   DSH 改设置时会重写 profile 的 cordis.patch.yml，
    //   实测 10/24 23:43 那次把本插件的整段配置**冲掉了** ——
    //   于是 credentialPath 变空 → 扫码登录报「没有配置 credentialPath」✗
    //
    //   插件不该因为"配置文件被别的程序重写"就整件事失能。
    //   所以：路径没配就退回 dataDir 下的默认位置 ——
    //   这正是主人在用的那个位置，所以行为不变，只是不会再空 ✓
    if (!String(this.baseConfig.credentialPath ?? "").trim())
      this.baseConfig.credentialPath = join(this.store.root, "credential.json");
    if (!String(this.baseConfig.writePolicyPath ?? "").trim())
      this.baseConfig.writePolicyPath = join(this.store.root, "write-policy.json");

    this.config = overrides.merge(this.baseConfig, overrides.readSettings(this.settingsPath));
    // 两本日记（给主人看的 / 只给她自己的）。2026-10-22 补 —— 养鱼有，这里原来没有 ✗
    // 2026-10-29：日记和信搬进家里（room\）。原来两本都摆在插件目录里，
    // 那是屋子外面另开的一个她 —— 现在由 config.diaryDir 指定落点，没配就还是原处。
    this.homeDir = String(config.diaryDir ?? "").trim();
    this.diary = new Diary({ store: this.store, dir: this.homeDir || this.store.root });
    if (this.homeDir !== "") this.store.lettersDir = this.homeDir;
    this.limits = { ...defaultLimits, ...config.limits };
    for (const key of Object.keys(defaultLimits))
      need(
        Number.isFinite(this.limits[key]) &&
          this.limits[key] >= 0 &&
          this.limits[key] <= defaultLimits[key],
        "INVALID_LIMIT",
      );
    this.fetcher = dependencies.fetcher || globalThis.fetch;
    this.active = new Set();
  }

  /**
   * 重读设置覆盖层。
   *
   * 为什么每次用之前都重读：主人在 GUI 里点了保存，不该还要重启 DSH 才生效 ✗
   * 一次小文件读取，代价可以忽略 ✓
   */
  reload() {
    this.config = overrides.merge(
      this.baseConfig,
      overrides.readSettings(this.settingsPath),
    );
    return this.config;
  }

  async task(fn, signal) {
    const id = this.store.start();
    const controller = new AbortController();
    this.active.add(controller);
    const budget = new Budget(
      this.store,
      id,
      this.limits,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    );
    try {
      const network = new Network(this.store, budget, {
        credentialPath: this.config.credentialPath,
        fetcher: this.fetcher,
      });
      const result = await fn(network, budget);
      budget.check();
      this.store.finish(id, "completed");
      return {
        taskId: id,
        result,
        usage: {
          requests: budget.requests,
          candidates: budget.candidates,
          asr_seconds: budget.asr,
          elapsed_ms: Date.now() - budget.started,
          tokens: null,
        },
      };
    } catch (e) {
      this.store.finish(
        id,
        e.code === "CANCELLED" ? "cancelled" : "failed",
        e.code || "INTERNAL_ERROR",
      );
      throw e;
    } finally {
      this.active.delete(controller);
      if (this.closing && this.active.size === 0) this.store.close();
    }
  }

  // ── 遇见：从偏好捞候选（允许一条都没有）────────────────────────────
  async candidates(count = 5, signal) {
    return this.task(async (network) => {
      const keywords = this.config.preferences?.like ?? [];
      const seen = this.store.seenBvids();
      // 2026-10-31：和抖音共用一份「看过什么」。那边看过的，这边也不重复挑。
      try {
        const taste = videoTaste.loadTaste();
        for (const id of Object.keys(taste.seen)) if (/^BV/i.test(id)) seen.add(id);
      } catch {}
      const r = await encounters.pool(network, {
        keywords,
        seen,
        limit: Math.min(12, Math.max(1, count)),
      });
      return { ...r, candidates: encounters.suggest(r.candidates) };
    }, signal);
  }

  /** 兴趣画像：B站和抖音共用一份，写成人话。 */
  taste() {
    try {
      return videoTaste.describeTaste(videoTaste.loadTaste());
    } catch {
      return "";
    }
  }

  /**
   * 记一次「留下 / 划走 / 看完就算」。
   *
   * 2026-10-31 加。原来 B站 这边只记「读过哪个 BV 号」，不记喜欢不喜欢——
   * 那样她的兴趣永远长不出来，每次都得从零猜。
   */
  decide(video, kind, why, topic = "") {
    const KINDS = ["stay", "skip", "enough"];
    if (!KINDS.includes(kind)) throw new Error("决定只能是 stay / skip / enough。");
    const text = String(why ?? "").trim();
    if (text === "") throw new Error("决定必须带理由——不写理由就等于没真看。");
    const state = videoTaste.loadTaste();
    const bvid = String(video?.bvid ?? video?.id ?? "");
    if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) throw new Error("记决定需要一个真实的 BV 号。");
    // 标题和分类：优先用调用方给的；没给就去读过的记录里找（read 时存过）
    let title = String(video?.title ?? "");
    let category = String(video?.tname ?? video?.category ?? "");
    if (title === "" || category === "") {
      try {
        const row = this.store.db
          .prepare("SELECT title FROM readings WHERE bvid=? ORDER BY created DESC LIMIT 1")
          .get(bvid);
        if (title === "" && row?.title) title = String(row.title);
      } catch { /* 读不到就用 bvid 顶上 */ }
    }
    const updated = videoTaste.recordDecision(state, {
      id: bvid,
      title: title || bvid,
      platform: "bili",
      kind,
      why: text,
      topic: String(topic || category || ""),
    });
    videoTaste.writeTasteMarkdown(state);
    return {
      ok: true,
      kind,
      topic: updated ?? null,
      taste: videoTaste.describeTaste(state),
    };
  }

  // ── 读：诚实取稿（A2 / A1）────────────────────────────────────────
  async read(input, page, signal) {
    const out = await this.task(async (network) => {
      const reading = await readVideo(input, page, network, this.store);
      return this.store.saveReading(reading);
    }, signal);
    // 活动账本：主人要能看到"她到底看了什么" ✓
    try {
      const r = out?.result ?? {};
      activity.record(this.store, {
        kind: "read",
        target: String(r.bvid ?? ""),
        title: String(r.title ?? ""),
        detail:
          `作者 ${r.author ?? ""} · 时长 ${r.duration ?? 0}s · 覆盖 ` +
          (r.coverage?.timed_fraction != null
            ? Math.round(r.coverage.timed_fraction * 100) + "%"
            : String(r.coverage?.state ?? "")),
        link: activity.videoLink(r.bvid) + (r.page && r.page > 1 ? "?p=" + r.page : ""),
      });
    } catch {}
    return out;
  }

  // ── 信笺：写一段可修正的理解（每天至多 2 篇，允许不写）──────────────
  journal(readingId, raw) {
    const reading = this.store.reading(readingId);
    const body = noteBody(raw, reading);
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare(
          "SELECT id FROM notes WHERE reading_id=? AND body=? ORDER BY created,id LIMIT 1",
        )
        .get(readingId, JSON.stringify(body));
      if (existing) {
        verifyInbox(this.store);
        return {
          id: existing.id,
          readingId,
          status: "local_reviewable_draft",
          path: join(this.store.root, "inbox.md"),
          deduplicated: true,
        };
      }
      const created = new Date().toISOString();
      enforceJournalDailyLimit(this.store, created);
      if (this.store.getControl("inbox:index-hash")) verifyInbox(this.store);
      const id = this.store.note(readingId, body, created);
      const path = exportInbox(this.store);
      return {
        id,
        readingId,
        status: "local_reviewable_draft",
        path,
        deduplicated: false,
      };
    });
  }

  inbox(args = {}) {
    return readInbox(this.store, args);
  }

  // ── 信：想说的时候才写（不是每轮必产）──────────────────────────────
  letter(args = {}) {
    const r = letters.write(this.store, args);
    try {
      activity.record(this.store, {
        kind: "letter",
        target: String(r.id ?? ""),
        title: String(args.body ?? "").slice(0, 120),
        detail: String(args.body ?? ""),
        status: "local",
        isTest: args.__test === true,
      });
    } catch {}
    return r;
  }

  letters(limit = 20) {
    return { ...letters.readFile(this.store), entries: letters.list(this.store, limit) };
  }

  // ── 日记：两本（给主人看的 / 只给她自己的）──────────────────────────
  //
  // 和「日子」(day) 的区别：
  //   day 是**一行心情**，用来回顾"那几天感觉怎么样"；
  //   diary 是**成篇的散文**，写"今天看见了什么、想了什么"。
  //
  // ⚠️ diary.write 不自动落盘（模块把这件事故意分开），所以这里写完要 exportFile ✓
  diaryWrite(kind, { mood = "", body = "", __test = false } = {}) {
    const r = this.diary.write(kind, { mood, body });
    try { this.diary.exportFile(kind) } catch { /* 导出失败不影响写库成功 */ }
    try {
      activity.record(this.store, {
        kind: "diary",
        target: kind,
        title: (mood ? mood + " · " : "") + String(body ?? "").slice(0, 100),
        detail: String(body ?? ""),
        status: "local",
        isTest: __test === true,
      });
    } catch {}
    return { ...r, path: this.diary.path?.(kind) ?? "" };
  }

  diaryRecent(kind, n = 7) {
    return this.diary.recent(kind, n);
  }

  diaryFile(kind) {
    return { ...this.diary.readFile(kind), entries: this.diary.recent(kind, 30) };
  }

  /** 她想用哪个模型（设置页写的；没写就是 null → 跟随 DSH 全局默认）*/
  wantedModel() {
    return models.wantedModel(this.config);
  }

  // ── 日子：记下今天的心情（她自己的，不是审计）──────────────────────
  day({ date, mood = null, note = null } = {}) {
    const d =
      date ||
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    need(/^\d{4}-\d{2}-\d{2}$/.test(d), "INVALID_DATE");
    return this.store.day(d, {
      mood: mood === null ? null : text(String(mood), 200),
      note: note === null ? null : text(String(note), 2000),
    });
  }

  days(limit = 30) {
    return this.store.days(limit);
  }

  // ── 平台写入（默认全部关闭；开关 + 授权文件缺一不可）──────────────
  //
  // 两条路：
  //   · platformWrite —— 历史 / 收藏 / 点赞 / 投币（humanism 的 Writer）
  //   · talk          —— 评论 / 弹幕 / 动态（养鱼的能力，这里重写过）
  //
  // 共同点：都要求 config 开关 + writePolicyPath 授权文件同时成立 ✓
  async platformWrite(kind, args, signal) {
    need(
      ["history", "favorites", "likes", "coins"].includes(kind),
      "WRITE_SCOPE_DENIED",
    );
    platformGrant(this.config, kind);
    try {
      const out = await this.task(
        (network) => new Writer(this.config, this.store, network).run(kind, args),
        signal,
      );
      // 活动账本：点赞/投币/收藏/历史也要能看见 ✓
      try {
        activity.record(this.store, {
          kind,
          target: String(args?.readingId ?? args?.bvid ?? ""),
          title: String(args?.bvid ?? args?.readingId ?? ""),
          detail: kind === "coins" ? `累计投币 ${args?.totalCoins ?? 1}` : "已完成",
          status: String(out?.result?.status ?? "ok"),
          isTest: args?.__test === true,
        });
      } catch {}
      return out;
    } catch (e) {
      // 失败也要记 —— "她尝试过什么、什么没成功"同样是主人该知道的 ✓
      try {
        activity.record(this.store, {
          kind,
          target: String(args?.readingId ?? ""),
          detail: String(e?.code ?? e?.message ?? e),
          status: "failed",
          isTest: args?.__test === true,
        });
      } catch {}
      throw e;
    }
  }

  async talk(kind, args, signal) {
    need(["comments", "danmaku", "dynamics"].includes(kind), "WRITE_SCOPE_DENIED");
    // ⚠️ 用 talk.mjs 的 grant（它认识表达类开关），不能用 writer.mjs 那个
    //    （那个只认 history/favorites/likes/coins，会直接 WRITE_SCOPE_DENIED ✗）
    talkGrant(this.config, kind);

    // 分享型评论：`share: true` 时把正文末尾补上 @主人
    //   为什么在 service 层做而不是让模型自己拼：
    //     模型拼 @ 容易拼错 mid/名字，也容易把 @ 塞进正文中间 ✗
    //     这里统一用设置页配的 owner.name，格式稳定 ✓
    let payload0 = args;
    if (kind === "comments" && args?.share === true) {
      const owner = this.config.owner ?? {};
      const ownerName = String(owner.name ?? "").trim() || String(this.config.persona?.ownerTitle ?? "主人");
      payload0 = {
        ...args,
        message: comments.shareText({ body: String(args.message ?? ""), ownerName }),
      };
      delete payload0.share; // Talker 的参数白名单里没有它
    }

    const isTest = args?.__test === true;
    // `__test` 是内部标记，Talker 的参数白名单里没有它 —— 必须剥掉再传 ✓
    const { __test: _ignored, ...payload } = payload0;

    try {
      const out = await this.task(
        (network) => new Talker(this.config, this.store, network).run(kind, payload),
        signal,
      );
      // 活动账本：发了什么、发在哪儿、平台接没接受 ✓
      try {
        const msg = String(payload?.message ?? payload?.text ?? "");
        const bvid = String(payload?.bvid ?? "");
        activity.record(this.store, {
          kind,
          target: bvid || String(payload?.roomId ?? "") || "dynamic",
          title: msg.slice(0, 120),
          detail: msg,
          status: String(out?.result?.status ?? "sent"),
          link: activity.videoLink(bvid),
          isTest,
        });
      } catch {}
      return out;
    } catch (e) {
      try {
        activity.record(this.store, {
          kind,
          target: String(payload?.bvid ?? payload?.roomId ?? "dynamic"),
          title: String(payload?.message ?? payload?.text ?? "").slice(0, 120),
          detail: String(e?.code ?? e?.message ?? e),
          status: "failed",
          isTest,
        });
      } catch {}
      throw e;
    }
  }

  // ── 倾听：扫评论区 / 回复草稿 ─────────────────────────────────────
  //
  // 从养鱼搬过来的机制，但改了一条关键的：
  //   养鱼允许 `--auto` 直接回；这里**没有自动回** ——
  //   回别人一律先落成草稿，主人在设置页点「发出去」才真发 ✓
  //   理由：公共空间里以她的身份回陌生人，是这个插件最有风险的动作。
  async commentDigest(args = {}, signal) {
    return this.task(async (network) => {
      // 评论接口只认 aid（oid）—— 只给了 BV 就先换一次
      // ⚠️ 这个转换放在这里而不是 comments.mjs 里：
      //    那个模块按约定"不偷偷发第二个请求"，转换的代价由调用方承担 ✓
      let oid = String(args.oid ?? "").trim();
      if (!oid && args.bvid) {
        const j = await network.get(
          new URL("https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(args.bvid)),
        );
        oid = String(j?.data?.aid ?? "");
        need(oid, "INVALID_OID");
      }
      need(oid, "INVALID_OID");
      return comments.digest(network, {
        ...args,
        oid,
        // 标"这条是主人发的"必须有主人的 mid；没配就退回 UP主口径（模块注释已说明）
        ownerMid: String(this.config.owner?.mid ?? "").trim() || null,
      });
    }, signal);
  }

  draftAdd(args) {
    return comments.draftAdd(this.store, args);
  }

  draftList() {
    return comments.draftList(this.store);
  }

  draftDrop(id) {
    return comments.draftDrop(this.store, id);
  }

  draftTake(id) {
    return comments.draftTake(this.store, id);
  }

  /**
   * 提交一条回复给别人的草稿 —— 安全词在这里拦，免审核也在这里判。
   *
   * 顺序很重要（这是主人明确要求的安全语义）：
   *   ① 先查安全词（对方说的话 + 她要说的），命中就**直接拒**，连草稿都不进 ✓
   *   ② 再看 reply.autoApprove：true 就直接发，false 才进待审队列 ✓
   *
   * ⚠️ 安全词检查放在 autoApprove **之前** ——
   *   否则"免审核"会把安全词也一起绕过，那安全词就形同虚设 ✗
   */
  async submitReply(args = {}, signal) {
    const R = this.config.reply ?? {};
    const words = (R.safetyWords ?? [])
      .map((w) => String(w ?? "").trim())
      .filter(Boolean);

    // 命中判断：对方原话 + 我要回的正文 + 昵称，全部小写比对
    const hay = [args.incoming, args.message, args.targetUname]
      .map((x) => String(x ?? "").toLowerCase())
      .join("\n");
    const hit = words.find((w) => hay.includes(w.toLowerCase()));
    if (hit) {
      try {
        activity.record(this.store, {
          kind: "comment",
          target: String(args.bvid ?? args.oid ?? ""),
          title: "安全词拦下，未回复",
          detail: `命中「${hit}」· 原文：${String(args.incoming ?? args.message ?? "").slice(0, 300)}`,
          status: "blocked_safety_word",
        });
      } catch {}
      return { action: "blocked", reason: "SAFETY_WORD", word: hit };
    }

    if (R.autoApprove === true) {
      const out = await this.talk(
        "comments",
        {
          oid: args.oid,
          root: args.root,
          parent: args.parent ?? args.rpid,
          bvid: args.bvid,
          message: args.message,
        },
        signal,
      );
      return { action: "sent", auto: true, sent: out?.result ?? out };
    }

    const draft = this.draftAdd(args);
    return { action: "drafted", auto: false, draft };
  }

  // ── 全天监听「别人找她」（2026-10-22 补）───────────────────────────
  //
  // 每 intervalSec 跑一次：拉「回复我的」→ 对每条符合条件的建草稿 + 记额度。
  // ⚠️ 额度到顶是**停**，不是跳过这一条继续听（主人明确要的语义）✓
  listenSettings() {
    return listen.listenSettings(this.config);
  }

  /** 今天的监听额度状态（UI 用） */
  listenQuota(date) {
    const d = date || shToday();
    const settings = this.listenSettings();
    return {
      ...listen.quota(this.store, d, settings),
      enabled: settings.enabled === true,
      dailyMax: settings.dailyMax,
      intervalSec: settings.intervalSec,
      perPersonMax: settings.perPersonMax,
      perVideoMax: settings.perVideoMax,
    };
  }

  /**
   * 拉一次「回复我的」，把「谁在找她」记进账本。
   *
   * ⚠️ 这里**不建草稿**。踩过的坑：
   *   `comments.draftAdd` 要求正文非空（MESSAGE_EMPTY），而监听阶段根本还没有正文 ——
   *   正文要她自己读了对方说的话才写得出来 ✗
   *   正确分工：监听只负责「发现」，把坐标记下来并叫醒她；
   *   她决定回谁、写什么，用 `bili_fishman_reply_draft` 落草稿，主人在设置页点头才发 ✓
   *
   * @returns {Promise<{scanned:number, found:Array, skipped:number, exhausted:boolean, reason:string}>}
   */
  async pollListen(signal, { dryRun = false } = {}) {
    const settings = this.listenSettings();
    if (settings.enabled !== true && !dryRun)
      return { scanned: 0, found: [], skipped: 0, exhausted: false, reason: "LISTEN_OFF" };

    const date = shToday();
    listen.resetIfNewDay(this.store, date);

    const out = { scanned: 0, found: [], skipped: 0, exhausted: false, reason: "" };

    return this.task(async (network) => {
      // 自己的 mid 从凭据里拿 —— 收件箱里出现自己的动作要丢掉
      let selfMid = "";
      try {
        const j = JSON.parse(readFileSync(this.config.credentialPath, "utf8"));
        selfMid = String(j.dedeuserid ?? "").trim();
      } catch {
        /* 凭据没有 mid 就不过滤自己，不影响主流程 */
      }

      const res = await listen.poll(this.store, network, {
        ownerMid: String(this.config.owner?.mid ?? "").trim(),
        selfMid,
        scope: settings.scope,
        perPersonDays: settings.perPersonDays,
        limit: 20,
      });
      out.scanned = res.items.length;

      // 已经有过的就不重复报 —— 账本里存一份「报过谁」，避免每次 tick 都叫醒她 ✓
      const seen = new Set((this.store.getControl("listen:seen") ?? []).map((x) => String(x)));

      for (const item of res.items) {
        if (item.replied) { out.skipped += 1; continue }
        const key = item.rpid ? "r:" + item.rpid : "m:" + item.mid + ":" + item.ctime;
        if (seen.has(key)) { out.skipped += 1; continue }

        // 额度检查放在每一条之前 —— 到顶就**立刻停**，后面的不再报 ✓
        const verdict = listen.canReply(
          this.store,
          { mid: item.mid, bvid: item.bvid, oid: item.oid },
          settings,
          date,
        );
        if (!verdict.ok) {
          out.exhausted = true;
          out.reason = verdict.reason;
          break;
        }

        const target = listen.replyTarget(item);
        if (!target) { out.skipped += 1; continue }

        out.found.push({
          rpid: String(item.rpid ?? ""),
          oid: String(target.oid ?? ""),
          root: String(target.root ?? ""),
          parent: String(target.parent ?? ""),
          bvid: String(item.bvid ?? ""),
          mid: String(item.mid ?? ""),
          uname: String(item.uname ?? ""),
          message: String(item.message ?? "").slice(0, 500),
          ctime: Number(item.ctime ?? 0),
          isOwner: item.isOwner === true,
        });
        seen.add(key);
        // 记账：报了就算她花过注意力（宁可保守，也不让它无限刷）
        // ⚠️ dryRun（设置页「测试」）**不记账** —— 主人明确要求测试不算当天次数 ✓
        if (!dryRun)
          listen.countReply(this.store, { mid: item.mid, bvid: item.bvid, oid: item.oid, rpid: item.rpid }, date);
      }

      if (!dryRun) {
        this.store.setControl("listen:seen", [...seen].slice(-200));
        if (out.found.length) {
          // 顺手写进「最近找过她的人」，设置页不用再跑一次网络就能显示 ✓
          const prev = this.store.getControl("listen:found") ?? [];
          this.store.setControl("listen:found", [...out.found.map((x) => ({ ...x, at: nowIso() })), ...prev].slice(0, 50));
        }
      }
      return out;
    }, signal);
  }

  /** 设置页用：最近谁找过她（不联网） */
  listenFound(limit = 20) {
    return (this.store.getControl("listen:found") ?? []).slice(0, limit);
  }

  /** 「她最近做了什么」—— 全部来自活动账本，不联网 ✓ */
  activities({ limit = 50, kind = null } = {}) {
    return activity.recent(this.store, { limit, kind });
  }

  activitySummary() {
    return activity.summary(this.store);
  }

  /**
   * 自检：把**当前激活的功能**跑一遍，让主人点一下就知道通不通。
   *
   * 三条硬约束（主人明确要求）：
   *   1. **不对外说任何话** —— 只发只读请求，绝不调 talk/writer ✓
   *   2. **不计入当天各种次数上限** —— 监听走 dryRun，额度账本前后快照+还原 ✓
   *   3. 一步失败不影响其它步 —— 每步单独 try/catch，报告里逐条列 ✓
   *
   * @returns {Promise<{steps:Array<{name:string,ok:boolean,detail:string}>, quotaRestored:boolean}>}
   */
  async selfTest(signal) {
    // 用最新配置跑（主人可能刚在设置页改完、还没点保存）
    try { this.reload(); } catch {}
    // 额度账本快照：跑完原样还回去 —— 测试不该消耗她今天的配额 ✓
    const snap = {
      quota: this.store.getControl("listen:quota"),
      seen: this.store.getControl("listen:seen"),
      found: this.store.getControl("listen:found"),
    };
    const steps = [];
    const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 200) });

    const cfg = this.config;
    await this.task(async (network) => {
      // ① 登录态
      let selfMid = "";
      try {
        const nav = await network.get(new URL("https://api.bilibili.com/x/web-interface/nav"));
        const d = nav?.data ?? {};
        selfMid = String(d.mid ?? "");
        add("登录态", d.isLogin === true, d.isLogin ? `${d.uname}（${d.mid}）· 硬币 ${d.money}` : `未登录 code=${nav?.code}`);
      } catch (e) {
        add("登录态", false, e?.code ?? e?.message ?? e);
      }

      // ② 模型目录
      try {
        const listed = models.listModels({ dataDir: this.store.root });
        const total = listed.groups.reduce((a, g) => a + g.models.length, 0);
        const want = models.wantedModel(cfg);
        add(
          "模型目录",
          total > 0,
          total ? `${listed.groups.length} 组 / ${total} 个模型` + (want?.provider ? `；她指定 ${want.provider}/${want.model}` : "") : "读不到模型目录",
        );
      } catch (e) {
        add("模型目录", false, e?.message ?? e);
      }

      // ③ 找候选（她每天第一件事）
      let firstBvid = "";
      try {
        const listed = encounters.pool
          ? await encounters.pool(network, {
              keywords: (cfg.preferences?.like ?? []).slice(0, 2),
              seen: new Set(this.store.seenBvids?.() ?? []),
              limit: 3,
            })
          : null;
        const cands = listed?.candidates ?? [];
        firstBvid = cands[0]?.bvid ?? "";
        add("找候选", cands.length > 0, cands.length ? `${cands.length} 条，第一条：${cands[0]?.title ?? ""}` : "今天没捞到（这也可以是正常结果）");
      } catch (e) {
        add("找候选", false, e?.code ?? e?.message ?? e);
      }

      // ④ 取稿链路（只查有没有字幕，不跑 ASR）
      try {
        const bv = firstBvid || (this.status().readings ?? [])[0]?.bvid || "";
        if (!bv) {
          add("取稿链路", true, "没有可试的视频（跳过）");
        } else {
          const view = await network.get(new URL("https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bv)));
          const cid = view?.data?.cid;
          const player = cid
            ? await network.get(new URL(`https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bv)}&cid=${cid}`))
            : null;
          const subs = player?.data?.subtitle?.subtitles ?? [];
          add("取稿链路", true, `${bv}：${subs.length ? subs.length + " 条字幕轨" : "无字幕（只能读标题/简介）"}`);
        }
      } catch (e) {
        add("取稿链路", false, e?.code ?? e?.message ?? e);
      }

      // ⑤ 评论区扫描（只有开了评论才测）
      if (cfg.enableCommentWrites === true || cfg.listen?.enabled === true) {
        try {
          const bv = firstBvid || "";
          if (!bv) add("评论区扫描", true, "没有可试的视频（跳过）");
          else {
            const view = await network.get(new URL("https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bv)));
            const aid = String(view?.data?.aid ?? "");
            const j = await network.get(new URL(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=1&ps=10&sort=2`));
            const n = (j?.data?.replies ?? []).length;
            add("评论区扫描", true, `${bv}：读到 ${n} 条评论`);
          }
        } catch (e) {
          add("评论区扫描", false, e?.code ?? e?.message ?? e);
        }
      } else {
        add("评论区扫描", true, "评论/监听都没开（跳过）");
      }

      // ⑥ 监听（只有开了才测；**dryRun，不记账**）
      if (cfg.listen?.enabled === true) {
        try {
          const res = await listen.poll(this.store, network, {
            ownerMid: String(cfg.owner?.mid ?? "").trim(),
            selfMid,
            scope: listen.listenSettings(cfg).scope,
            perPersonDays: listen.listenSettings(cfg).perPersonDays,
            limit: 10,
          });
          add("全天监听", true, `读到 ${res.items.length} 条「回复我的」`);
        } catch (e) {
          add("全天监听", false, e?.code ?? e?.message ?? e);
        }
      } else {
        add("全天监听", true, "没开启（跳过）");
      }

      return steps;
    }, signal);

    // 还原额度：不管跑成功没有都要还 ✓
    let quotaRestored = false;
    try {
      for (const [k, v] of Object.entries(snap)) {
        this.store.setControl("listen:" + (k === "quota" ? "quota" : k), v ?? null);
      }
      quotaRestored = true;
    } catch {
      quotaRestored = false;
    }

    // ── ⑦ 产出物：让主人**真的能看到东西** ─────────────────────────
    //
    // 2026-11-08 改：日记和信已经搬去世界插件了（世界是记忆中心），
    // 这里不再往 B站 插件的目录里写那两样。自检只剩「能发的话发一条 @主人的评论」。
    // 这也是**只读**的一部分：测试不该在她的日记本上留手印。
    const stamp = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
    const artifacts = [];


    // ⑦-3 发一条 @主人的评论（只有开了评论写入 + 有授权才可能成功）
    {
      const ownerName = String(cfg.owner?.name ?? "").trim() || String(cfg.persona?.ownerTitle ?? "主人");
      const bv = (this.status().readings ?? [])[0]?.bvid ?? "";
      if (cfg.enableCommentWrites !== true) {
        add("产出·@主人的评论", false, "评论写入没开 —— 打开「说话能力 → 评论」并配好授权文件才会真发");
        artifacts.push({ what: "@主人的评论", ok: false, where: "", note: "评论写入未开启" });
      } else if (!bv) {
        add("产出·@主人的评论", false, "还没有读过的视频，没有地方可以评论");
        artifacts.push({ what: "@主人的评论", ok: false, where: "", note: "没有可用视频" });
      } else {
        try {
          const view = await this.task(
            (network) => network.get(new URL("https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bv))),
            signal,
          );
          const aid = String(view?.result?.data?.aid ?? "");
          const out = await this.talk(
            "comments",
            {
              oid: aid,
              bvid: bv,
              share: true,
              __test: true,
              message: `【测试】@${ownerName} 这是设置页「测试」按钮发的一条，用来确认评论链路是通的。`,
            },
            signal,
          );
          const link = activity.videoLink(bv);
          const sent = out?.result ?? out ?? {};
          const rpid = sent.rpid ? String(sent.rpid) : "";
          artifacts.push({
            what: "@主人的评论",
            ok: true,
            where: link,
            note:
              "平台已接收" + (rpid ? "（rpid " + rpid + "）" : "") +
              " · 新号/低等级号可能会先审、评论区要过一会儿才看得到",
          });
          add(
            "产出·@主人的评论",
            true,
            `已发到 ${bv}（${sent.status ?? "sent"}${rpid ? " · rpid " + rpid : ""}）`,
          );
        } catch (e) {
          add("产出·@主人的评论", false, e?.code ?? e?.message ?? e);
          artifacts.push({ what: "@主人的评论", ok: false, where: "", note: String(e?.code ?? e?.message ?? e) });
        }
      }
    }

    // ⑧ 活动账本（让主人能看到"她到底做了什么"）
    try {
      const acts = this.activities({ limit: 5 });
      add("活动账本", true, acts.length ? `最近 ${acts.length} 条：` + acts.map((a) => a.kind).join("、") : "还没有记录");
    } catch (e) {
      add("活动账本", false, e?.message ?? e);
    }

    // ⑦ 本地账本（不联网）
    try {
      const st = this.status();
      // 2026-11-08：信和信笺已经搬去世界了，这里只报 B站 自己的账。
      add("本地账本", true, `读过的 ${st.readings?.length ?? 0} 条 · 活动账本 ${st.activity ? Object.values(st.activity).reduce((a, b) => a + b, 0) : 0} 条`);
    } catch (e) {
      add("本地账本", false, e?.code ?? e?.message ?? e);
    }

    // steps 是闭包捕获的同一个数组，网络那几步已经 push 进去了，不用再合并 ✓
    // artifacts = 这次**真的产出了什么**（日记 / 信 / 评论），主人据此核对 ✓
    return { steps, quotaRestored, artifacts };
  }

  confirmConsumption(readingId, seconds) {
    return confirmConsumption(this.store, readingId, seconds);
  }

  // ── 人格札记 ──────────────────────────────────────────────────────
  personality(action, args = {}) {
    return personality(
      this.store,
      action,
      args,
      this.config.enablePersonalityLearning === true,
    );
  }

  // ── 记忆 ──────────────────────────────────────────────────────────
  memory(action, id = "", body = null) {
    need(["list", "put", "delete"].includes(action), "INVALID_MEMORY_ACTION");
    if (action === "put") {
      need(
        body && ["self", "user"].includes(body.subject),
        "THIRD_PARTY_PROFILE_DENIED",
      );
      need(
        Object.keys(body).every((k) =>
          [
            "subject",
            "understanding",
            "evidence",
            "uncertainty",
            "next_response",
          ].includes(k),
        ),
        "INVALID_MEMORY_FIELD",
      );
      for (const key of [
        "understanding",
        "evidence",
        "uncertainty",
        "next_response",
      ])
        text(body[key] || "");
      need(body.understanding && body.evidence, "MEMORY_EVIDENCE_REQUIRED");
    }
    return this.store.memory(action, id, body);
  }

  // ── 本地媒体导入（ASR / 画面文字）──────────────────────────────────
  importLocal(readingId, raw) {
    return this.task(async (_network, budget) => {
      const r = this.store.reading(readingId);
      need(["A3", "frame"].includes(raw.route), "INVALID_ROUTE");
      if (raw.route === "A3") {
        need(raw.duration === r.duration, "DURATION_MISMATCH");
        budget.spend("asr", raw.duration);
      }
      const segs = segments(raw.segments, r.duration, raw.route);
      need(segs.length > 0, "EMPTY_LOCAL_SOURCE");
      return this.store.saveReading({
        ...r,
        route: raw.route,
        segments: segs,
        coverage: {
          ...coverage(segs, r.duration, raw.route),
          state: raw.route === "frame" ? "visual_text_partial" : "asr_partial",
        },
        localEvidence:
          "User/host supplied import; content not independently verified.",
        cached: false,
      });
    });
  }

  status() {
    const p = this.store.getControl("pause");
    const journals = journalDailyStatus(this.store);
    const writes = writeStatus(this.config);
    const talk = talkStatus(this.config);
    return {
      ...this.store.status(),
      journals,
      // ⭐ 明确告诉她：没写日记不是失败
      posture: {
        noDiscoveryIsFine: true,
        note: "今天没有新发现、没有想说的话，都是合法结果。读取不受限；写入能力都在，但默认关闭，用不用由你决定。",
      },
      letters: {
        // 表可能不存在（老库、或损坏）——status 是「还能不能干活」的唯一入口，
        // 不能因为读不到信就整个崩掉，那会让主人以为插件死透了 ✗
        count: (() => {
          try {
            return this.store.db
              .prepare("SELECT count(*) AS n FROM letters")
              .get().n;
          } catch {
            return 0;
          }
        })(),
        path: join(this.store.lettersDir || this.store.root, "信.md"),
      },
      days: (() => {
        try {
          return this.store.days(7);
        } catch {
          return [];
        }
      })(),
      pause: p,
      // 她用哪个模型 / 分享给谁 —— 设置页要显示，status 也要能查到 ✓
      model: { ...(this.config.model ?? {}), source: this.config.model?.provider ? "config" : "default" },
      owner: this.config.owner ?? {},
      share: { enabled: (this.config.share ?? {}).enabled !== false },
      // 全天监听：今天的额度用到哪了、有没有因为到顶停下 ✓
      listen: this.listenQuota(),
      // 「她最近做了什么」的分类计数 —— 活动列表用 activities() 拿明细 ✓
      activity: this.activitySummary(),
      diary: {
        open: this.diaryRecent("open", 1),
        private: this.diaryRecent("private", 1),
      },
      writes: (() => {
        // 七项开关的当前值（来自配置 + 设置覆盖层）
        const enabledMap = {
          comments: talk.switches.comments,
          danmaku: talk.switches.danmaku,
          dynamics: talk.switches.dynamics,
          history: writes.switches.history,
          favorites: writes.switches.favorites,
          likes: writes.switches.likes,
          coins: writes.switches.coins,
        };
        const ALL = {
          comments: "bili_fishman_comment",
          danmaku: "bili_fishman_danmaku",
          dynamics: "bili_fishman_dynamic",
          history: "bili_fishman_history",
          favorites: "bili_fishman_favorite",
          likes: "bili_fishman_like",
          coins: "bili_fishman_coin",
        };
        return {
          ...enabledMap,
          // 工具**始终注册**（改了开关立刻生效，不用重启）；
          // registered 列出来是为了跟 enabled 区分开 —— 有工具 ≠ 能用 ✓
          registered: Object.values(ALL),
          enabled: Object.entries(ALL)
            .filter(([k]) => enabledMap[k])
            .map(([, v]) => v),
          note:
            "七项写入工具始终注册；能不能真的发出去，取决于「开关 true」+「授权文件 write-policy.json」。缺一样都返回 WRITE_DISABLED / WRITE_POLICY_INVALID。",
        };
      })(),
    };
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    for (const controller of this.active) controller.abort();
    if (this.active.size === 0) this.store.close();
  }
}

export function readingView(reading, offset = 0) {
  need(
    Number.isInteger(offset) &&
      offset >= 0 &&
      offset <= reading.segments.length,
    "INVALID_OFFSET",
  );
  const chosen = [];
  let length = 0;
  for (const segment of reading.segments.slice(offset)) {
    if (length + segment.text.length > 16000 && chosen.length) break;
    chosen.push(segment);
    length += segment.text.length;
    if (length >= 16000) break;
  }
  return {
    ...reading,
    segments: chosen,
    segment_count: reading.segments.length,
    next_offset:
      offset + chosen.length < reading.segments.length
        ? offset + chosen.length
        : null,
    source_text_partial: offset > 0 || chosen.length < reading.segments.length,
  };
}

export { safeError };
