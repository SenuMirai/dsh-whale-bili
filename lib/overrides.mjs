// 设置覆盖层 —— 让「设置 → 刷B站」能改配置，而不用去编辑 cordis.patch.yml。
//
// 为什么要单独一层（而不是直接改 cordis.patch.yml）：
//   · 那个文件是 DSH 的 profile 配置，有注释、有别的插件的段，程序化改写很容易把它弄坏 ✗
//   · 而且它是"部署配置"，本来就不该被 UI 频繁改 ✓
//
// 分层：
//   cordis.patch.yml（基础：路径、凭据、默认值）
//        ↓ 被覆盖
//   <dataDir>/settings.json（UI 写的：人设 / 偏好 / 作息 / 七个写入开关）
//
// 只允许覆盖白名单里的键 —— 路径和凭据**不能**从 UI 改（那是安全边界）✓

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** UI 可改的键（其余一律不可覆盖）*/
export const OVERRIDE_KEYS = [
  "persona",
  "preferences",
  "night",
  // 2026-10-22 加：主人要在设置页里切模型、填自己的 mid/昵称、控制分享
  "model",
  "owner",
  "share",
  "listen",
  "reply",
  "enablePersonalityLearning",
  "enableCommentWrites",
  "enableDanmakuWrites",
  "enableDynamicWrites",
  "enableHistoryWrites",
  "enableFavoriteWrites",
  "enableLikeWrites",
  "enableCoinWrites",
];

/** ⚠️ 这些**故意**不在白名单里：dataDir / credentialPath / writePolicyPath /
 *  accountStateDir / maxSessionTokens / sessionCwd
 *  —— 它们决定"数据写哪儿、用谁的凭据、授权文件在哪"，
 *     能改它们就等于能绕过安全检查 ✗ 只允许在 cordis.patch.yml 里由人手工改。
 */
export const READONLY_KEYS = [
  "dataDir",
  "credentialPath",
  "writePolicyPath",
  "accountStateDir",
  "maxSessionTokens",
  "sessionCwd",
];

export function settingsPath(dataDir) {
  return join(dataDir, "settings.json");
}

export function readSettings(file) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** 只留下白名单里的键（防止 UI 顺手把路径也改了）*/
export function pick(obj) {
  const out = {};
  for (const k of OVERRIDE_KEYS) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * 写设置。
 *
 * ⚠️ 2026-10-22 修的 bug：原来是 `pick(patch)` **整体覆盖**文件 ——
 *   如果调用方只传了一个字段（比如只改安全词），其余设置会被**全部冲掉** ✗
 *   回环测试 test/settings-roundtrip.test.mjs 抓到了这一条。
 *
 * 现在先读旧值、深合并、再落盘。想清空某个字段就显式传空值（[] / "" / false），
 * 而不是靠"不传" —— "不传"现在的语义是"保持不变" ✓
 */
export function writeSettings(file, patch) {
  const prev = readSettings(file);
  const next = pick(merge(prev, pick(patch)));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  return next;
}

/** 深度合并：over 覆盖 base；对象递归，数组整体替换 ✓ */
export function merge(base, over) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined) continue;
    const b = out[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      b &&
      typeof b === "object" &&
      !Array.isArray(b)
    )
      out[k] = merge(b, v);
    else out[k] = v;
  }
  return out;
}

/**
 * 把作息窗口在"可编辑文本"和"结构化数组"之间转换。
 * UI 里一行写 "20:00-23:00, 10:30-12:00" 比让用户点一堆数字轻松得多 ✓
 */
export function parseWindows(text) {
  return String(text ?? "")
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d{1,2}:\d{2})\s*[-–~到]\s*(\d{1,2}:\d{2})$/);
      return m ? { start: m[1], end: m[2] } : null;
    })
    .filter(Boolean)
    .slice(0, 4);
}

export function formatWindows(windows) {
  if (!Array.isArray(windows) || !windows.length) return "";
  return windows
    .map((w) => `${w.start ?? ""}-${w.end ?? ""}`)
    .filter((s) => s !== "-")
    .join(", ");
}
