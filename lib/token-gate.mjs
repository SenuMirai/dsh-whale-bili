/**
 * token-gate —— 给 dsh-bili-fishman 用的预算闸门
 *
 * ── 为什么这个文件和 humanism 的不一样 ──────────────────────────────────
 * fishman 是从 dsh-bili-humanism（v1.11.3）改的，但它调用的接口是**改之前**那一版：
 *
 *   import { checkTokenBudget, DEFAULT_SESSION_TOKENS } from './lib/token-gate.mjs'
 *   const metering = checkTokenBudget(store, sessionId, totals, limit)
 *   need(metering.used === null || metering.used <= metering.limit, 'TOKEN_BUDGET')
 *
 * 而 humanism 现在导出的是 `checkReadTokenBudget(store, segments, limit)` /
 * `DEFAULT_READ_TOKENS`，签名和语义都变了。直接拿过来会报
 * "does not provide an export named 'DEFAULT_SESSION_TOKENS'"。
 *
 * 所以这里按 fishman 的调用契约重新实现，不去猜 humanism 的新语义。
 *
 * ── 语义 ────────────────────────────────────────────────────────────────
 * 估算口径和 humanism 一致：**一个 UTF-8 字节算一个估算 token**。
 * 不是厂商用量，也不是账单限额，只是个保守的自我约束。
 * 拿不到用量时返回 used: null —— 调用方 (index.js) 的判定是
 * `used === null || used <= limit`，也就是「算不出来就先放行」，不会卡死她。
 */

import { need } from './errors.mjs';

/** 一次会话允许的估算 token 上限。 */
export const DEFAULT_SESSION_TOKENS = 600_000;

/** 和 humanism 那边保持同名，方便以后迁移。 */
export const DEFAULT_READ_TOKENS = DEFAULT_SESSION_TOKENS;
export const READ_TOKEN_ESTIMATE = 'segment_text_utf8_bytes';

/**
 * 从 fishman 记的 totals 里挖出「已经用掉多少」。
 *
 * 它可能记在几个不同字段上（不同版本改过名），所以按顺序试，
 * 一个都对不上就返回 null。
 */
function usedFrom(totals) {
  if (totals === null || totals === undefined || typeof totals !== 'object') return null;
  const candidates = ['total', 'used', 'tokens', 'readTokens', 'bytes', 'input', 'output'];
  for (const key of candidates) {
    const v = totals[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  }
  return null;
}

/**
 * 检查这一轮还能不能继续读。
 *
 * @returns {{ used: number|null, limit: number, estimate: string }}
 *   `used === null` = 算不出用量，调用方应放行。
 */
export function checkTokenBudget(store, sessionId, totals, limit) {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_SESSION_TOKENS;
  return {
    used: usedFrom(totals),
    limit: cap,
    estimate: READ_TOKEN_ESTIMATE,
  };
}

/** 兼容 humanism 的新签名：按段落文本算用量。 */
export function checkReadTokenBudget(store, segments, limit = DEFAULT_READ_TOKENS) {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_READ_TOKENS;
  let used = 0;
  for (const seg of segments ?? []) {
    const text = typeof seg === 'string' ? seg : (seg?.text ?? '');
    used += Buffer.byteLength(String(text), 'utf8');
  }
  return { used, limit: cap, estimate: READ_TOKEN_ESTIMATE };
}

/** 校验配置里的上限是不是正数。 */
export function readTokenLimit(config = {}) {
  for (const key of ['maxSessionTokens', 'maxReadTokens']) {
    const v = config[key];
    if (v === undefined) continue;
    need(Number.isSafeInteger(v) && v > 0, 'INVALID_TOKEN_LIMIT');
  }
  return config.maxSessionTokens ?? config.maxReadTokens ?? DEFAULT_SESSION_TOKENS;
}
