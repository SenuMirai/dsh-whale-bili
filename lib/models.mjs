// 模型目录 —— 只读 DSH 已经接好的 WorkBuddy 目录文件，不碰网络。
//
// 为什么要这个模块：主人接了两个 WorkBuddy provider（国内 `workbuddy` / 国际 `workbuddy-ai`），
// 花的是 WorkBuddy 积分，不是按 token 充值。设置页要能列出"有哪些可选、现在用的是哪个"，
// 否则只能靠猜。这里的函数都不发请求、不写文件，UI 反复轮询也不会产生副作用。
//
// 一个刻意的取舍：目录文件缺失 / 没权限 / 坏 JSON 时**静默跳过那个 provider**。
// 这不是错误 —— 没装 WorkBuddy 的人只是看到空列表，不该让整个设置页 500。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CATALOGS = [
  { provider: "workbuddy", label: "WorkBuddy（国内版）", file: ".workbuddy-catalog.json" },
  { provider: "workbuddy-ai", label: "WorkBuddy AI（国际版）", file: ".workbuddy-ai-catalog.json" },
];

/**
 * 解析 DSH 主目录。
 *
 * ⚠️ 2026-10-22 修的坑：原来只认 `process.env.DSH_HOME`。
 *   但**宿主进程里这个变量不一定有**（它是 shell 包装层设的），于是传进来是空串 →
 *   所有 catalog 都读不到 → 设置页只剩「跟随默认」，主人看到的是
 *   「（读不到 —— 现在用的是 DSH 全局默认）」✗
 *
 * 所以按可靠度依次兜底：环境变量 → profile 目录的父级 → dataDir 的父级 → ~/.dsh
 */
export function resolveDshHome({ dshHome, dataDir } = {}) {
  const explicit = String(dshHome ?? "").trim();
  if (explicit) return explicit;

  const envHome = String(process.env.DSH_HOME ?? "").trim();
  if (envHome) return envHome;

  // DSH_PROFILE_DIR 形如 <dsh>/.dsh/profiles/desktop → 往回两级就是 <dsh>/.dsh
  const profileDir = String(process.env.DSH_PROFILE_DIR ?? "").trim();
  if (profileDir) {
    const up = dirname(dirname(profileDir));
    if (up && up !== "." && up !== "/") return up;
  }

  // dataDir 形如 <dsh>/.dsh/bili-fishman → 父级就是 <dsh>/.dsh
  const dd = String(dataDir ?? "").trim();
  if (dd) {
    const up = dirname(dd);
    if (up && up !== "." && up !== "/") return up;
  }

  return join(homedir(), ".dsh");
}

/** 读 JSON；任何失败都返回 null —— 调用方据此跳过这个 provider，而不是炸掉整个列表。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 把调用方解析好的当前选择规整成固定三字段，避免 UI 拿到 undefined 还要自己兜底。 */
function normalizeCurrent(current) {
  const provider = String(current?.provider ?? "").trim();
  const model = String(current?.model ?? "").trim();
  // current 可能已经带 source（config / session）。没带就按"配置优先"的默认口径标 config，
  // 而不是替调用方猜一个 session —— 猜错会让界面显示错误的来源。
  const source = String(current?.source ?? (provider || model ? "config" : "")).trim();
  return { provider, model, source };
}

/**
 * 免费在前，同组按名字排序。
 * 同名的保持目录里的原始顺序（Array.sort 是稳定排序），不额外按 id 重新洗牌，
 * 这样同一个 catalog 每次渲染出来的顺序完全一致，UI 不会看起来在"跳"。
 */
function compareModels(a, b) {
  if (a.free !== b.free) return a.free ? -1 : 1;
  return String(a.name).localeCompare(String(b.name));
}

/**
 * 列出可用模型分组。
 * @returns {{groups: Array<{provider: string, label: string, models: Array<{id: string, name: string, contextWindow: number|null, free: boolean}>}>, current: {provider: string, model: string, source: string}}}
 */
export function listModels({ dshHome, current, dataDir } = {}) {
  // ⚠️ 用 resolveDshHome 而不是直接用参数：宿主进程可能没有 DSH_HOME，
  //    传进来是空串时这里必须自己兜底，否则界面永远只剩「跟随默认」✗
  const home = resolveDshHome({ dshHome, dataDir });
  const groups = [];

  {
    // 去重键带 provider 前缀：同一个模型 id 允许同时出现在国内 / 国际两个 provider 下，
    // 它们的计费和可用性不是一回事，不能合成一条。同一个 provider 内部的重复才是噪音。
    const seen = new Set();
    for (const cat of CATALOGS) {
      const data = readJson(join(home, cat.file));
      if (!data) continue;

      const models = [];
      for (const entry of Object.values(data.entries ?? {})) {
        // 目录结构是 entries.<uuid>.models[]；entry 可能没有 models，按空数组处理。
        for (const m of Array.isArray(entry?.models) ? entry.models : []) {
          const id = String(m?.id ?? "").trim();
          // 没有 id 的条目没法交给 selectModel，留着只会让下拉框点不动。
          if (!id) continue;

          const key = cat.provider + "::" + id;
          if (seen.has(key)) continue;
          seen.add(key);

          models.push({
            id,
            name: String(m?.name ?? id),
            contextWindow: m?.contextWindow ?? null,
            free: m?.billing?.free === true,
          });
        }
      }

      // 空 provider 不塞进 groups：界面不用处理"点开一个没有任何模型的分组"。
      if (models.length) {
        models.sort(compareModels);
        groups.push({ provider: cat.provider, label: cat.label, models });
      }
    }
  }

  return { groups, current: normalizeCurrent(current) };
}

/**
 * 从会话记录里推断上次用的模型（配置没指定时用）。
 *
 * 为什么读 projcache：DSH 把 modelSelection.lastUsed 写在这里，
 * 它代表"她上一次真正跑起来时用的模型"，比全局默认更接近主人看到的实际状态。
 *
 * @returns {{provider: string, model: string}|null}
 */
export function sessionModel({ dshHome, sessionId, dataDir } = {}) {
  // 同 listModels：宿主进程可能没有 DSH_HOME，这里必须自己兜底 ✓
  const home = resolveDshHome({ dshHome, dataDir });
  // 兼容调用方顺手传 "xxx.json"；真正拼路径前必须去扩展名，否则会变成 xxx.json.json。
  const id = String(sessionId ?? "").trim().replace(/\.json$/i, "");

  // sessionId 来自外部时可能带 ../ 或路径分隔符 —— 那会读出任意本地 JSON。
  // 这里只放行纯文件名，宁可返回 null（调用方回退到配置 / 默认）也不越界。
  if (!home || !id || id.includes("/") || id.includes("\\") || id.includes("..")) return null;

  const data = readJson(
    join(home, "storages", "session_projcache", "sessions", id + ".json"),
  );
  const used = data?.record?.rows?.modelSelection?.val?.lastUsed;
  const provider = String(used?.provider ?? "").trim();
  const model = String(used?.model ?? "").trim();
  if (!provider || !model) return null;

  return { provider, model };
}

/**
 * 生成需要切换的目标；没配就返回 null（保持 DSH 全局默认，不强行干预）。
 *
 * 契约只到 provider/model：reasoningEffort 是调用方传给 selectModel 的另一个维度，
 * 在这里顺手带上会让"没配"和"配了但没写推理档位"两种状态混在一起，所以不掺进来。
 *
 * @returns {{provider: string, model: string}|null}
 */
export function wantedModel(config) {
  // 配置形状与参考实现一致：config.model = { provider, model }。
  // 不把 config 本身当模型对象读，避免把别的顶层字段误认成模型选择。
  const sel = config?.model;
  if (!sel || typeof sel !== "object") return null;

  const provider = String(sel.provider ?? "").trim();
  const model = String(sel.model ?? "").trim();
  if (!provider || !model) return null;

  return { provider, model };
}
