// 调度器 —— 让她自己醒来。
//
// 从养鱼继承的机制（这部分是对的）：
//   插件常驻在 DSH 里 → 自己 tick → 到点用 sessionController.prompt 塞一个回合给她 ✓
//   这样"过日子"是真的自己过，不是人戳一下才动 ✓
//
// 但养鱼在这上面踩了两个坑，这里都要避开：
//
// 坑 ①：她那个会话的 cwd 用了 `C:\Users\<user>`，而系统 temp 是
//        `C:\Users\<user>\AppData\Local\Temp` —— **嵌套**。Windows ACL 沙箱要求
//        「工作区不能包含 temp」，于是每一次 pwsh 都 EPERM，四天一条命令都没跑成 ✗
//        → 这里 pickSessionCwd() 专门挑一个不嵌套的目录，并且**用 workingDirectory.set 纠正旧会话** ✓
//
// 坑 ②：叫醒她的话是九步硬流程（deps→日记→feed→深读→打分→日记→扫评论→通知→收工），
//        每一步都必须产出 → 任何一步失败整轮白醒 ✗
//        → 这里 wakePrompt 只有三句话，且明确说"什么都不做也行" ✓

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  plan,
  wakePrompt,
  readState,
  writeState,
  shDate,
  nowMin,
} from "./clock.mjs";

const TICK_MS = 60_000;

/**
 * 挑一个她那个会话能用的工作目录。
 *
 * 硬规则（DSH 的 Windows ACL 沙箱）：工作区不能与系统临时目录互相嵌套，
 * 否则 `materializeAclGrant()` 抛 "Windows ACL temp root must be outside the workspace"，
 * 之后**每一次 shell 调用**都失败 —— 养鱼就是这么死的 ✗
 */
export function pickSessionCwd({ dshHome, explicit = "" } = {}) {
  const isWin = process.platform === "win32";
  const norm = (p) => {
    try {
      return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
    } catch {
      return String(p).toLowerCase();
    }
  };
  const nests = (a, b) => {
    const x = norm(a);
    const y = norm(b);
    return (
      x === y ||
      x.startsWith(y + path.sep) ||
      x.startsWith(y + "/") ||
      y.startsWith(x + path.sep) ||
      y.startsWith(x + "/")
    );
  };
  const tmp = (() => {
    try {
      return os.tmpdir();
    } catch {
      return "";
    }
  })();

  const candidates = [
    explicit,
    path.join(dshHome, "bili-fishman"),
    path.join(dshHome, "bili-fishman", "work"),
  ].filter((p) => typeof p === "string" && p.trim());

  for (const raw of candidates) {
    const abs = path.resolve(String(raw).trim());
    // 跨盘符 → 天然不嵌套
    const crossDrive =
      isWin &&
      tmp &&
      path.parse(abs).root.toLowerCase() !== path.parse(tmp).root.toLowerCase();
    if (!crossDrive && tmp && nests(abs, tmp)) continue;
    try {
      fs.mkdirSync(abs, { recursive: true });
      const probe = path.join(abs, ".write-probe");
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      return {
        cwd: abs,
        why: crossDrive ? "跨盘符，天然不与 temp 嵌套" : "与系统临时目录不嵌套",
      };
    } catch {
      /* 试下一个 */
    }
  }

  return {
    cwd: os.homedir(),
    why: "兜底（可能与 temp 嵌套，shell 会失败）",
    warn: true,
  };
}

/**
 * 她此刻真正的家会话（2026-11-08 加）。
 *
 * 以前的错：叫醒固定发给 SESSION_ID = "bili-fishman" 那个自建会话，
 * 而主人真正在用的「她」是 dsh-world 的家会话（世界目录 life.json 里的 homeSessionId）。
 * 结果 B站 那一轮醒来、读片、写日记的全是另一个会话里的另一个她 ——
 * 主人看到的就是「有个插件里的 AI 在刷」。
 *
 * 现在先问家里要人：worlds/<worldId>/life.json 的 homeSessionId，
 * 再到 ctx.agents 里确认它真的在跑。拿不到才退回旧的自建会话（并且日志写清楚）。
 */
export function readHomeSessionId(dshHome, worldId) {
  try {
    const file = path.join(dshHome, "worlds", worldId || "default", "life.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const id = String(raw?.homeSessionId ?? "").trim();
    return id || "";
  } catch {
    return "";
  }
}

export function startClock(ctx, config, service) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const STATE = path.join(dshHome, "bili-fishman-night.json");
  // 旧的自建会话 id：只有家里还没起来时才用（拿不到家会话时兜底）
  const LEGACY_SESSION_ID = "bili-fishman";
  const WORLD_ID = String(config.homeWorldId ?? "default").trim() || "default";
  const USE_HOME = config.useHomeSession !== false;
  /** 这一轮到底叫谁。空串 = 家里没有家会话，退回 LEGACY_SESSION_ID。 */
  let wiredSessionId = "";
  /** 上次为什么没接上家：给设置页显示，不猜。 */
  let wiredNote = "";
  /** 只读地看一眼家里记着谁（不唤醒会话）。 */
  function homeSessionId() {
    if (!USE_HOME) return "";
    return readHomeSessionId(dshHome, WORLD_ID);
  }
  /**
   * 真的把家会话准备好。
   *
   * 光有 id 不够 —— 重启之后她可能还没被载入，ctx.agents 里就没有她，
   * 这时往那个 id 发 prompt 会直接失败。sessionController.resolveAgent 会把会话载起来，
   * 所以这里先问它。载不起来才退回自建会话，并且把原因写进日志和设置页。
   */
  async function resolveHome(home) {
    const agents = ctx.get?.("agents") ?? ctx.agents;
    try {
      if (typeof agents?.get === "function" && agents.get(home)) return true;
    } catch {
      /* 注册表拿不到就继续走 resolveAgent */
    }
    try {
      if (typeof ctx.sessionController?.resolveAgent === "function") {
        const found = await ctx.sessionController.resolveAgent(home);
        if (found && "agent" in found && found.agent) return true;
        wiredNote = "家会话载不起来：" + String(found?.error?.message ?? found?.error?.code ?? "未知原因");
        return false;
      }
    } catch (e) {
      wiredNote = "家会话载不起来：" + String(e?.message ?? e).slice(0, 120);
      return false;
    }
    // 没有 resolveAgent 的旧版宿主：只能认注册表里现有的那个
    try {
      if (typeof agents?.get === "function" && agents.get(home)) return true;
    } catch {}
    wiredNote = "这个会话当前没被载入（旧版宿主没有 resolveAgent）";
    return false;
  }
  /** 叫醒/监听都走这里：优先家会话，家里没有才用自建会话。 */
  function targetSession() {
    return wiredSessionId || LEGACY_SESSION_ID;
  }
  const log = (m) => {
    try {
      console.log(m);
    } catch {}
  };

  // ⚠️ 没有 sessionController（比如测试、或宿主还没就绪）就**不挂定时器** ✗
  //   否则 setInterval 会一直吊着事件循环，测试进程永远退不出去
  //
  // ⚠️ 这里**不再**因为 night.enabled === false 就整个退出：
  //   生物钟关掉不该连带把「全天监听」也关掉（那是两个独立开关）✗
  //   night 的判断放到 tick() 里面 ✓
  if (!ctx.sessionController) {
    return { stop() {}, tick: async () => {}, listenTick: async () => {}, invalidate() {} };
  }

  let sessionReady = false;
  let sessionCwd = "";
  let ticking = false;
  let timer = null;

  /** 确保她的会话存在，并且 cwd 是能跑 shell 的那种 */
  async function ensureSession() {
    const want = pickSessionCwd({ dshHome, explicit: config.sessionCwd });
    if (want.warn) {
      log(
        `[fishman] ⚠️ 找不到不与 temp 嵌套的目录 → 退回 ${want.cwd}；` +
          `她的 shell 会因 Windows ACL 限制失败。请配置 sessionCwd。`,
      );
    }
    // 先看家里有没有人
    const home = homeSessionId();
    if (home && (await resolveHome(home))) {
      if (wiredSessionId !== home) {
        log(`[fishman] 叫醒目标 → 家会话 ${home}（世界 ${WORLD_ID}）`);
        wiredSessionId = home;
        wiredNote = "";
        appliedModel = ""; // 换了会话就要重新核模型
      }
      sessionReady = true;
      return;
    }
    if (home && !wiredNote) wiredNote = "家会话没准备好";
    if (wiredSessionId !== LEGACY_SESSION_ID) {
      log(`[fishman] ⚠️ 没找到家会话（worlds/${WORLD_ID}/life.json）→ 退回自建会话 ${LEGACY_SESSION_ID}，这一轮不是家里的她`);
      wiredSessionId = LEGACY_SESSION_ID;
      appliedModel = "";
    }
    if (!sessionReady) {
      try {
        await ctx.sessionController.create({ sessionId: LEGACY_SESSION_ID, cwd: want.cwd });
      } catch {
        /* 已存在就忽略；下面会纠正 cwd */
      }
      sessionReady = true;
      sessionCwd = want.cwd;
    }
    await fixCwd(want.cwd);
  }

  /**
   * 纠正已存在会话的 cwd。
   *
   * ⚠️ 实测：`ctx.sessionController` **没有** setWorkingDirectory
   *   （它只有 create/selectModel/rename/fork/prompt/...）。
   *   真正能改的是 `ctx.workingDirectory.set(agent, path)`，要的是 agent 对象，
   *   而 agent 得从 `ctx.agents.get(sessionId)` 拿 ✓
   */
  async function fixCwd(want) {
    if (sessionCwd === want) return;
    const wd = ctx.get?.("workingDirectory") ?? ctx.workingDirectory;
    if (!wd || typeof wd.set !== "function") {
      sessionCwd = want;
      return;
    }
    const agents = ctx.get?.("agents") ?? ctx.agents;
    const agent =
      typeof agents?.get === "function" ? agents.get(targetSession()) : undefined;
    if (!agent) return; // 还没进注册表 → 下一 tick 再试
    try {
      if (typeof wd.get === "function") {
        const cur = wd.get(agent.session);
        if (
          cur &&
          path.resolve(String(cur)).toLowerCase() === path.resolve(want).toLowerCase()
        ) {
          sessionCwd = want;
          return;
        }
      }
      await wd.set(agent, want);
      sessionCwd = want;
      log(`[fishman] 她的工作目录 → ${want}（避开与 temp 嵌套 ✓）`);
    } catch (e) {
      log(`[fishman] 改工作目录失败（${want}）：${String(e?.message ?? e).slice(0, 160)}`);
    }
  }

  // ── 叫醒前切模型（2026-10-22 从养鱼搬过来）──────────────────────────
  //
  // 主人可以在设置页指定她那个会话用哪个模型。切换接口是
  //   ctx.sessionController.selectModel({ sessionId, provider, model })
  //
  // ⚠️ 只在**真的变了**的时候切：
  //   selectModel 会写会话存档 + 后台存默认，每 tick 都切是白折腾 ✗
  let appliedModel = "";
  async function applyModel(cfg) {
    // 2026-11-08：这一轮要是发进家会话，就别替主人改她的模型。
    // 家会话用哪个模型是主人在界面上选的；插件擅自动它会让人以为「她换了脑子」。
    // 只有显式打开 forceModelOnHome 才切（回退用）。
    if (targetSession() !== LEGACY_SESSION_ID && cfg?.forceModelOnHome !== true) return;
    const want = cfg?.model ?? {};
    const provider = String(want.provider ?? "").trim();
    const model = String(want.model ?? "").trim();
    if (!provider || !model) return;            // 没配就用全局默认（保持原行为 ✓）
    const key = provider + "/" + model;
    if (appliedModel === key) return;
    if (typeof ctx.sessionController.selectModel !== "function") {
      log("[fishman] 这个 DSH 版本没有 selectModel → 模型选择不可用，继续用默认");
      appliedModel = key;                        // 记下来，别每 tick 刷同一条日志
      return;
    }
    try {
      await ctx.sessionController.selectModel({
        sessionId: targetSession(),
        provider,
        model,
        ...(want.reasoningEffort ? { reasoningEffort: want.reasoningEffort } : {}),
      });
      appliedModel = key;
      log(`[fishman] 已切到 ${key}`);
    } catch (e) {
      // 切不过去不该让整轮叫醒失败 —— 用默认模型照样能过日子 ✓
      log(`[fishman] 切换模型 ${key} 失败：${e?.message ?? e}（继续用默认）`);
      appliedModel = key;
    }
  }

  async function tick() {
    if (ticking) return;
    if (!ctx.sessionController) return;
    // 每次 tick 重读设置覆盖层：GUI 里改了作息 / 关掉生物钟，下一分钟就生效 ✓
    const cfg = service?.reload ? service.reload() : config;
    if (cfg.night?.enabled === false) return;

    const state = readState(STATE);
    const today = shDate();

    // 今天还没计划 → 排一个
    if (!state || state.date !== today || (!state.action && !state.fired)) {
      const p = plan(cfg, state);
      writeState(STATE, p);
      log(`[fishman] 今天的计划：${p.action}${p.atText ? " @ " + p.atText : ""}${p.reason ? "（" + p.reason + "）" : ""}`);
      return;
    }

    if (state.action !== "wake" || state.fired) return;
    if (nowMin() < Number(state.at)) return;

    ticking = true;
    try {
      await ensureSession();
      await applyModel(cfg);
      await ctx.sessionController.prompt(
        {
          requestId: `bili-fishman-${Date.now()}`,
          sessionId: targetSession(),
          mode: "queue",
          content: [{ type: "text", text: wakePrompt(state, cfg) }],
        },
        new AbortController().signal,
      );
      writeState(STATE, { ...state, fired: true, wokeAt: new Date().toISOString() });
      log(`[fishman] 醒了 · ${state.atText ?? ""}`);
    } catch (e) {
      log(`[fishman] 叫醒失败：${String(e?.message ?? e).slice(0, 160)}（下一 tick 重试）`);
    } finally {
      ticking = false;
    }
  }

  // ── 全天监听「别人找她」（2026-10-22 加）────────────────────────────
  //
  // 和生物钟分开的第二个定时器：生物钟管"她什么时候可以醒"，
  // 这个管"有没有人在找她"。两者互不影响 —— 监听关掉不该让生物钟停 ✓
  //
  // ⚠️ 叫醒她时说清楚**谁在找她、说了什么**，但不替她写回复：
  //   写什么必须她自己读了对方的话才知道。
  let listening = false;
  let listenTimer = null;
  let lastListenAt = 0;

  function listenPrompt(found, cfg) {
    const who = String(cfg.persona?.name ?? "").trim() || "我";
    const owner = String(cfg.persona?.ownerTitle ?? "").trim() || "主人";
    const lines = found.slice(0, 5).map((x, i) => {
      const from = x.isOwner ? owner : "@" + (x.uname || "网友");
      const where = x.bvid ? x.bvid : "av" + (x.oid || "");
      return `${i + 1}. ${from}（${where}）说：${String(x.message || "").slice(0, 120)}`;
    });
    return [
      `【有人在找你】${found.length} 条新的。`,
      "",
      ...lines,
      "",
      "想回的话，用 bili_fishman_reply_draft 写成草稿 —— 草稿会先给主人看，他点头才发出去。",
      "不想回或者不知道说什么，就放着，什么都不用做。",
    ].join("\n");
  }

  async function listenTick() {
    if (listening || !ctx.sessionController) return;
    const cfg = service?.reload ? service.reload() : config;
    const want = Number(cfg.listen?.intervalSec ?? 300);
    const intervalSec = Math.max(60, Number.isFinite(want) ? want : 300);
    if (cfg.listen?.enabled !== true) return;
    // 频率由配置说了算：不到点就跳过（定时器本身是固定 60s 的粗粒度）
    if (Date.now() - lastListenAt < intervalSec * 1000) return;

    listening = true;
    try {
      lastListenAt = Date.now();
      const out = await service.pollListen();
      if (!out?.found?.length) return;
      await ensureSession();
      await applyModel(cfg);
      await ctx.sessionController.prompt(
        {
          requestId: `bili-fishman-listen-${Date.now()}`,
          sessionId: targetSession(),
          mode: "queue",
          content: [{ type: "text", text: listenPrompt(out.found, cfg) }],
        },
        new AbortController().signal,
      );
      log(`[fishman] 监听：${out.found.length} 条新的，已叫她`);
    } catch (e) {
      // 监听出错不该影响生物钟；风控类的暂停由下层记，这里只记一行 ✓
      log(`[fishman] 监听失败：${String(e?.message ?? e).slice(0, 160)}`);
    } finally {
      listening = false;
    }
  }

  timer = setInterval(() => {
    tick().catch(() => {});
  }, TICK_MS);
  // 监听用更粗的 60s 心跳，具体频率由 listenTick 按配置自己判断
  listenTimer = setInterval(() => {
    listenTick().catch(() => {});
  }, 60_000);
  setTimeout(() => {
    tick().catch(() => {});
  }, 8000);
  setTimeout(() => {
    listenTick().catch(() => {});
  }, 20000);

  // 2026-11-08：开机先握一次手。
  // 冷启动时 wiredSessionId 还是空的，设置页只能显示「未接入」—— 那是假象。
  // 这里主动解析一次家会话，把状态落定，不用等 20:38 那一轮才看得见。
  setTimeout(() => {
    if (!ctx.sessionController) return;
    ensureSession()
      .then(() => {
        if (targetSession() !== LEGACY_SESSION_ID) log(`[fishman] 已接入家会话 ${targetSession()}`);
      })
      .catch((e) => log(`[fishman] 启动握手失败：${String(e?.message ?? e).slice(0, 120)}`));
  }, 2000);

  log(`[fishman] 生物钟已启动（每 ${TICK_MS / 1000}s tick · ${USE_HOME ? "家会话 " + WORLD_ID : "自建会话"}）`);

  return {
    stop() {
      if (timer) clearInterval(timer);
      if (listenTimer) clearInterval(listenTimer);
      timer = null;
      listenTimer = null;
    },
    tick,
    listenTick,
    /**
     * 现在就叫一次（2026-11-08 加，给设置页的「现在叫她刷一次」按钮）。
     *
     * 走和定时唤醒完全相同的路：同样的目标会话解析、同样的叫醒词，
     * 只是不等计划里的时刻。返回值直接说明这一轮发给了谁 ——
     * 主人不用再靠猜「到底是不是家里那个她」。
     */
    async wakeNow() {
      if (!ctx.sessionController) throw new Error("sessionController 没挂上，叫不动她");
      const cfg = service?.reload ? service.reload() : config;
      await ensureSession();
      await applyModel(cfg);
      const sessionId = targetSession();
      await ctx.sessionController.prompt(
        {
          requestId: `bili-fishman-manual-${Date.now()}`,
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: wakePrompt({ atText: "现在（手动叫的）" }, cfg) }],
        },
        new AbortController().signal,
      );
      log(`[fishman] 手动叫醒 → ${sessionId}`);
      return {
        sessionId,
        wiredHome: targetSession() !== LEGACY_SESSION_ID,
        homeWorldId: WORLD_ID,
        note: wiredNote,
      };
    },
    /** 这一轮会叫哪个会话：给设置页显示「接入的是哪个她」。 */
    target() {
      const home = homeSessionId();
      const active = wiredSessionId && wiredSessionId !== LEGACY_SESSION_ID ? wiredSessionId : "";
      /**
       * 三种状态得分开说，别混成一句「未接入」：
       *   confirmed — 已经真的把话发进去过（wiredSessionId 指向家会话）
       *   found     — 家里记着这个会话，但还没叫过它，所以还没验证过
       *   none      — 家里没记，或者记着的那个载不起来
       */
      const state = active ? "confirmed" : home ? "found" : "none";
      return {
        homeWorldId: WORLD_ID,
        useHomeSession: USE_HOME,
        // 家里 life.json 记着的那个
        homeSessionId: home || null,
        // 这一轮实际会发给谁
        sessionId: active || (USE_HOME && home ? home : wiredSessionId || LEGACY_SESSION_ID),
        wiredHome: state !== "none",
        state,
        note: wiredNote,
        checkedAt: new Date().toISOString(),
      };
    },
    /** 配置变了：清掉今天的计划，下一 tick 按新配置重排 */
    invalidate() {
      const s = readState(STATE);
      if (s && s.date === shDate() && s.fired) return; // 已经醒过就别再排
      writeState(STATE, { date: shDate() });
      tick().catch(() => {});
    },
  };
}