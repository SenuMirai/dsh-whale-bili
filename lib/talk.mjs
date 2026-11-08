// 说话层 —— 评论、弹幕、动态。
//
// 这三个是**养鱼独有的能力**，humanism 那边一个都没有（它明确不做表达）。
// 主人要的是「能力都在，用不用由她决定」，所以这里全部实现，
// 但默认**一个都不注册**：只有主人在配置里显式打开对应开关，工具才会出现。
//
// 与养鱼原版的差别（这三条是这次重做时特意加的）：
//
//   1. **发之前要有一份"授权"**（本地 JSON），不是配个 true 就能发。
//      授权里写清楚：给谁发、发在哪些目标上、多少条、什么时候过期。
//      这和 humanism 的四项写入是同一套思路 —— 一个布尔开关太容易误开 ✗
//
//   2. **发之前先回读**：确认账号是谁、目标还在、内容没超长。
//      发完**再回读一次**核对真的发出去了（养鱼只有评论做了 thread 复核）。
//
//   3. **结果不明就停**：超时/重定向/解析失败 → 不重试，记 pending，等人核对。
//      这条是从 humanism 的 writer 学的，养鱼那边没有。
//
// 保留养鱼的谨慎：
//   · 一次一条，不批量、不铺量
//   · 同一个人 30 天只回一次（可选）
//   · 每日额度硬限制
//   · 撞到风控立刻停手

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store, digest, now } from "./store.mjs";
import { credential } from "./network.mjs";
import { Fault, need } from "./errors.mjs";

const API = "https://api.bilibili.com";
const LIVE = "https://api.live.bilibili.com";

/** 三类表达的固定接口（模型无法指定任意 URL ✓） */
const routes = {
  comment: "/x/v2/reply/add",
  dynamic: "/x/dynamic/feed/create/dyn",
  danmaku: "/msg/send", // 直播弹幕，域名是 api.live.bilibili.com
};

/** 开关 → 授权里的字段 */
const switches = {
  comments: "enableCommentWrites",
  dynamics: "enableDynamicWrites",
  danmaku: "enableDanmakuWrites",
  history: "enableHistoryWrites",
  favorites: "enableFavoriteWrites",
  likes: "enableLikeWrites",
  coins: "enableCoinWrites",
};

const numeric = (v) =>
  typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v));

function jsonFile(path, code) {
  try {
    const bytes = readFileSync(path);
    need(bytes.length <= 65536, code);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Fault(code);
  }
}

/**
 * 读并校验授权文件。
 *
 * 与 humanism 的 grant() 同构，但多了表达类（评论/弹幕/动态）的字段。
 * 关键：**开关和授权缺一不可** —— 只有开关没授权 = 拒；只有授权没开关 = 拒。
 */
export function grant(config, kind) {
  need(Object.hasOwn(switches, kind), "WRITE_SCOPE_DENIED");
  need(config[switches[kind]] === true, "WRITE_DISABLED");
  const p = jsonFile(config.writePolicyPath, "WRITE_POLICY_INVALID");
  need(
    p?.version === 1 && p.enabled === true && p.handoverConfirmed === true,
    "WRITE_POLICY_INVALID",
  );
  need(typeof p.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(p.id), "WRITE_POLICY_INVALID");
  need(
    typeof p.expiresAt === "string" &&
      Number.isFinite(Date.parse(p.expiresAt)) &&
      Date.parse(p.expiresAt) > Date.now(),
    "WRITE_GRANT_EXPIRED",
  );
  need(p[kind]?.enabled === true, "WRITE_SCOPE_DENIED");
  need(
    Number.isInteger(p[kind].maxWrites) && p[kind].maxWrites >= 1 && p[kind].maxWrites <= 100,
    "WRITE_POLICY_INVALID",
  );
  return p;
}

/** 表达类额外要求：目标白名单 */
function targets(p, kind) {
  const list = p[kind]?.targets;
  need(Array.isArray(list) && list.length > 0 && list.length <= 100, "WRITE_TARGET_DENIED");
  return list;
}

function secrets(path, kind) {
  const session = credential(path);
  const j = jsonFile(path, "WRITE_CREDENTIAL_INVALID");
  need(session && j.write_valid !== false, "WRITE_CREDENTIAL_INVALID");
  need(/^[a-fA-F0-9]{32}$/.test(j.bili_jct || ""), "WRITE_CREDENTIAL_INVALID");
  // 弹幕和点赞/投币需要设备 cookie
  const needDevice = ["likes", "coins", "danmaku"].includes(kind);
  const device = needDevice ? j.buvid3 : "";
  need(
    typeof device === "string" &&
      device.length <= 256 &&
      !/[\r\n;]/.test(device) &&
      (!needDevice || device.length > 0),
    "WRITE_DEVICE_REQUIRED",
  );
  return { session, csrf: j.bili_jct, device };
}

export function accountStore(config, accountId) {
  need(numeric(accountId), "WRITE_POLICY_INVALID");
  const root =
    config.accountStateDir ||
    join(process.env.DSH_HOME || join(homedir(), ".dsh"), "bili-fishman-accounts");
  return new Store(join(root, accountId));
}

function idle(state) {
  for (const task of state.db.prepare("SELECT id,pid FROM tasks WHERE status='running'").all()) {
    let alive = true;
    try {
      process.kill(task.pid, 0);
    } catch (e) {
      alive = e.code !== "ESRCH";
    }
    need(!alive, "TASK_BUSY");
    state.finish(task.id, "interrupted", "PROCESS_EXIT");
  }
}

/**
 * 表达写入器：评论 / 弹幕 / 动态。
 *
 * 流程与 humanism 的 Writer 对齐：先持久化意图 → 再发 → 再回读核验。
 * 任何"可能已经发出去了"的异常 → 记 pending + 暂停，不重试 ✓
 */
export class Talker {
  constructor(config, localStore, network) {
    this.config = config;
    this.local = localStore;
    this.network = network;
  }

  async run(kind, args) {
    const allowed = {
      comments: ["oid", "message", "root", "parent", "bvid"],
      danmaku: ["roomId", "message", "replyMid", "replyName"],
      dynamics: ["text", "bvid"],
    }[kind] || [];
    need(Object.keys(args).every((k) => allowed.includes(k)), "UNKNOWN_PARAMETER");

    const p = grant(this.config, kind);

    const message = String(args.message ?? args.text ?? "").trim();
    need(message.length > 0, "MESSAGE_EMPTY");

    // 长度上限（平台限制，提前挡，别等平台拒）
    if (kind === "comments") need(message.length <= 1000, "MESSAGE_TOO_LONG");
    if (kind === "danmaku") need(message.length <= 20, "DANMAKU_TOO_LONG");
    if (kind === "dynamics") need(message.length <= 2000, "DYNAMIC_TOO_LONG");

    // 目标必须在授权白名单里
    // ⚠️ 顺序很重要：**先校验目标和内容，再去读凭据**。
    //   反过来的话，一个目标越权的调用会先报"凭据无效"，
    //   把真正的拒绝原因盖掉 —— 那对使用者是误导 ✗
    const list = targets(p, kind);
    const target =
      kind === "comments"
        ? `BV:${args.bvid ?? ""}`.replace(/BV:$/, `oid:${args.oid}`)
        : kind === "danmaku"
          ? `room:${args.roomId}`
          : "dynamic";
    need(
      list.includes(target) || (kind === "dynamics" && list.includes("dynamic")),
      "WRITE_TARGET_DENIED",
    );

    const auth = secrets(this.config.credentialPath, kind);
    need(auth.session === this.network.secret, "WRITE_CREDENTIAL_CHANGED");

    const fingerprint = digest(p);
    const state = accountStore(this.config, p.accountId);
    const n = this.network;
    let taskId;
    let intent;
    let failed = false;

    const guard = () => {
      need(digest(grant(this.config, kind)) === fingerprint, "WRITE_GRANT_CHANGED");
      need(digest(secrets(this.config.credentialPath, kind)) === digest(auth), "WRITE_CREDENTIAL_CHANGED");
      need(!state.getControl("pause"), "PERSISTENT_PAUSE");
      n.budget.check();
    };

    try {
      taskId = state.start();
      need(!state.getControl("write:pending"), "WRITE_RESULT_UNKNOWN");
      n.guard = guard;

      // ① 核对账号
      const nav = (await n.get(API + "/x/web-interface/nav")).data;
      need(
        nav?.isLogin === true && String(nav.mid) === p.accountId,
        "WRITE_ACCOUNT_MISMATCH",
      );

      // ② 组装请求
      let url;
      let body;
      if (kind === "comments") {
        const oid = String(args.oid ?? "");
        need(numeric(oid), "INVALID_OID");
        url = API + routes.comment;
        body = { type: 1, oid, message, plat: 1 };
        if (args.root) body.root = String(args.root);
        if (args.parent) body.parent = String(args.parent);
      } else if (kind === "danmaku") {
        need(numeric(String(args.roomId ?? "")), "INVALID_ROOM");
        url = LIVE + routes.danmaku;
        body = { roomid: String(args.roomId), msg: message, color: 16777215, fontsize: 25, mode: 1 };
        if (args.replyMid) body.reply_mid = String(args.replyMid);
        if (args.replyName) body.reply_name = String(args.replyName);
      } else {
        // 动态：先取 csrf 之外需要的参数，正文放 content
        url = API + routes.dynamic;
        body = {
          type: 4, // 4 = 纯文字
          content: JSON.stringify({ paragraphs: [{ text: message }] }),
        };
        if (args.bvid) body.rid = args.bvid;
      }
      body.csrf = auth.csrf;

      // ③ 发之前持久化意图（结果不明时能查）
      n.beforePost = () => {
        guard();
        state.tx(() => {
          const key = "quota:" + p.id + ":" + kind;
          const used = state.getControl(key) || 0;
          need(used < p[kind].maxWrites, "WRITE_QUOTA_EXHAUSTED");
          const last = state.getControl("write:last") || 0;
          // 平台节奏：同一账号至少间隔 60 秒（养鱼那边也是这么做的）
          need(Date.now() - last >= 60000, "WRITE_RATE_LIMIT");
          intent = {
            id: randomUUID(),
            kind,
            accountId: p.accountId,
            grantId: p.id,
            target,
            messageDigest: digest(message),
            messageLength: message.length,
            createdAt: now(),
            status: "pending",
          };
          state.setControl(key, used + 1);
          state.setControl("write:last", Date.now());
          state.setControl("write:pending", intent);
        });
      };

      const reply = await n.request(new URL(url), "api", {
        method: "POST",
        body: new URLSearchParams(body),
        csrf: auth.csrf,
        device: auth.device,
      });

      guard();

      // ④ 回读核验（评论能查到 rpid 就记下）
      // ⚠️ 2026-10-22 补：把平台返回的 rpid / 审核状态也带出去。
      //   实测：账号等级低的号，评论**会被平台先审**——接口返回 code 0 表示"已接收"，
      //   但公开评论区里立刻看不到 ✗。以前只回一句"可能延迟"，主人根本无法核对。
      //   现在把 rpid 和平台原始返回一起给出，至少能对着号去查 ✓
      const platform = reply?.data ?? {};
      const rpid = platform?.rpid_str ?? platform?.rpid ?? platform?.reply?.rpid ?? null;
      state.tx(() => {
        state.setControl("write:receipt:" + intent.id, {
          ...intent,
          status: "sent",
          sentAt: now(),
          rpid: rpid == null ? null : String(rpid),
        });
        state.setControl("write:pending", null);
        // 记"回过这个人"（给 once-per-person 用）
        if (kind === "comments" && args.parent) {
          const key = "replied:" + args.parent;
          const hist = state.getControl(key) || [];
          state.setControl(key, [...hist.slice(-20), now()]);
        }
      });

      return {
        id: intent.id,
        kind,
        status: "sent",
        target,
        rpid: rpid == null ? null : String(rpid),
        platformCode: reply?.code ?? null,
        // ⚠️ 平台可能延迟显示，低等级号还可能先进审核；这里只说"请求已被接受" ✓
        note:
          "Request accepted by the platform (code 0)." +
          (rpid ? " rpid=" + String(rpid) + "." : "") +
          " Visibility may lag, and new accounts sometimes go through review first; this does not prove others can see it yet.",
      };
    } catch (e) {
      failed = true;
      // 只要意图已经落地，就说明可能已经发出去了 → 不重试、记 pending ✓
      if (taskId && (intent || state.getControl("write:pending"))) {
        state.pause("WRITE_RESULT_UNKNOWN");
        this.local.pause("WRITE_RESULT_UNKNOWN");
        throw new Fault("WRITE_RESULT_UNKNOWN");
      }
      if (taskId && e.code === "WRITE_ACCOUNT_MISMATCH")
        this.local.pause("WRITE_ACCOUNT_MISMATCH");
      throw e;
    } finally {
      n.guard = null;
      n.beforePost = null;
      if (taskId)
        state.finish(
          taskId,
          state.getControl("write:pending") ? "interrupted" : failed ? "failed" : "completed",
        );
      state.close();
    }
  }
}

/** 表达层的状态（给 status 工具看） */
export function talkStatus(config) {
  const on = {
    comments: config.enableCommentWrites === true,
    danmaku: config.enableDanmakuWrites === true,
    dynamics: config.enableDynamicWrites === true,
  };
  const tools = [
    ...(on.comments ? ["bili_fishman_comment"] : []),
    ...(on.danmaku ? ["bili_fishman_danmaku"] : []),
    ...(on.dynamics ? ["bili_fishman_dynamic"] : []),
  ];
  return { switches: on, tools };
}

/** 人工核对结果（本地 CLI 用，模型工具没有这个能力） */
export function resolveUnknown(config, operationId, outcome) {
  need(["applied", "not-applied"].includes(outcome), "INVALID_WRITE_OUTCOME");
  const p = jsonFile(config.writePolicyPath, "WRITE_POLICY_INVALID");
  const state = accountStore(config, p.accountId);
  try {
    state.tx(() => {
      idle(state);
      const item = state.getControl("write:pending");
      need(item?.id === operationId, "UNKNOWN_WRITE_NOT_FOUND");
      state.setControl("write:receipt:" + operationId, {
        ...item,
        status: "human_resolved_" + outcome,
        resolvedAt: now(),
      });
      state.setControl("write:pending", null);
    });
    return { id: operationId, status: "human_resolved_" + outcome, pausePreserved: true };
  } finally {
    state.close();
  }
}

/** 人工解除暂停（本地 CLI 用，模型工具没有这个能力） */
export function resumeWrites(config) {
  const p = jsonFile(config.writePolicyPath, "WRITE_POLICY_INVALID");
  const state = accountStore(config, p.accountId);
  try {
    state.tx(() => {
      need(!state.getControl("write:pending"), "WRITE_RESULT_UNKNOWN");
      idle(state);
      state.resume();
    });
    return { accountId: p.accountId, pauseCleared: true };
  } finally {
    state.close();
  }
}
