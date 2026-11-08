/**
 * 刷视频的共用账本（B站 / 抖音共用一份）。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────
 * 2026-10-31 加的。原来两边的记录是分开的：
 *   - B站插件只记「读过哪个 BV 号」（seenBvids），不记喜欢不喜欢
 *   - 抖音那边根本没有跨次的记忆
 * 结果就是：同一个我，在这边刚看过的东西，到那边完全不记得。
 *
 * 现在两边都写这一份：
 *   - seen：看过什么（防止重复挑）
 *   - decisions：每次的决定 + 理由（这是最值钱的，理由里有真实的感受）
 *   - topics：从决定里长出来的兴趣画像
 *
 * ── 一条硬规矩 ────────────────────────────────────────────────────
 * 兴趣只从**真实做过的事**里长，不从「看到了什么主题」里猜：
 *   - 留下 2 次以上才算「喜欢」
 *   - 划走 2 次以上、且没有留下过，才算「不喜欢」
 *   - 一次的决定只记事实，不改画像
 *   - 「看完就算」既不加分也不减分
 *
 * 这条是为了防止「看见了」被写成「喜欢」——那跟编「猫名字」是同一个病。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 状态目录。放这儿是因为 room 在 ~/.dsh 下，运行时直接写会被沙箱拦（EPERM）。 */
export const DEFAULT_TASTE_DIR = 'C:/DSHwork/tmp/刷视频';

const now = () =>
  new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');

export function tasteDirOf(root = DEFAULT_TASTE_DIR) {
  const dir = String(root || DEFAULT_TASTE_DIR).trim() || DEFAULT_TASTE_DIR;
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  return dir;
}

export function loadTaste(root = DEFAULT_TASTE_DIR) {
  const file = join(tasteDirOf(root), 'state.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== 1) throw new Error('bad version');
    parsed.seen = parsed.seen ?? {};
    parsed.decisions = parsed.decisions ?? [];
    parsed.topics = parsed.topics ?? [];
    return parsed;
  } catch {
    return { version: 1, seen: {}, decisions: [], topics: [] };
  }
}

export function saveTaste(state, root = DEFAULT_TASTE_DIR) {
  const dir = tasteDirOf(root);
  state.updatedAt = new Date().toISOString();
  if (state.decisions.length > 500) state.decisions = state.decisions.slice(-500);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

/** 这一条看过没有 */
export function hasSeen(state, id) {
  return Object.prototype.hasOwnProperty.call(state.seen, id);
}

/**
 * 记一次决定，并更新兴趣画像。
 * @returns 更新后的主题状态（如果这条片子有主题的话）
 */
export function recordDecision(state, input, root = DEFAULT_TASTE_DIR) {
  const why = String(input.why ?? '').trim();
  if (why === '') throw new Error('决定必须带理由——不写理由就等于没真看。');

  const at = now();
  const topicKey = String(input.topic ?? '').trim().slice(0, 30);

  // 同一条片子只认最后一次决定：先把它之前那次记的账撤掉，免得同一条反复改口把画像带偏。
  const prev = state.seen[input.id];
  if (prev && prev.kind !== 'enough' && topicKey !== '') {
    const old = state.topics.find((x) => x.key === topicKey);
    if (old) {
      if (prev.kind === 'stay' && old.stays > 0) old.stays -= 1;
      if (prev.kind === 'skip' && old.skips > 0) old.skips -= 1;
      old.signal = old.stays >= 2 ? 'like' : old.skips >= 2 && old.stays < 2 ? 'dislike' : 'neutral';
    }
  }

  state.seen[input.id] = { at, kind: input.kind, why };
  // decisions 里同一条也只留最后一次
  state.decisions = state.decisions.filter((d) => d.id !== input.id);
  state.decisions.push({
    id: input.id,
    title: input.title,
    platform: input.platform,
    kind: input.kind,
    why,
    topic: topicKey,
    at,
  });

  let updated;
  if (topicKey.length >= 2 && input.kind !== 'enough') {
    let t = state.topics.find((x) => x.key === topicKey);
    if (!t) {
      t = { key: topicKey, signal: 'neutral', stays: 0, skips: 0, firstAt: at };
      state.topics.push(t);
    }
    if (input.kind === 'stay') {
      t.stays += 1;
      if (t.stays >= 2) t.signal = 'like';
    } else if (input.kind === 'skip') {
      t.skips += 1;
      if (t.skips >= 2 && t.stays < 2) t.signal = 'dislike';
    }
    t.lastAt = at;
    updated = t;
  }

  saveTaste(state, root);
  return updated;
}

/**
 * 给候选打分。**只做减法不做加法**：
 * 没接触过的主题一律 0 分，不会因为「看起来像喜欢的类型」就加分。
 * 只有真留下过的才加，真划走过的才减。这样新东西永远有机会被挑中。
 */
export function scoreCandidate(state, candidate) {
  if (hasSeen(state, candidate.id)) return { score: -999, why: ['看过了'] };
  const hay = [candidate.title, candidate.category ?? '', (candidate.tags ?? []).join(' '), candidate.desc ?? '']
    .join(' ')
    .toLowerCase();
  let score = 0;
  const why = [];
  for (const t of state.topics) {
    if (t.signal === 'neutral') continue;
    if (!hay.includes(String(t.key).toLowerCase())) continue;
    if (t.signal === 'like') {
      const w = Math.min(6, t.stays || 1);
      score += w;
      why.push(`${t.key}（以前留下过 ${t.stays} 次）`);
    } else {
      const w = Math.min(6, t.skips || 1);
      score -= w;
      why.push(`${t.key}（以前划走过 ${t.skips} 次）`);
    }
  }
  if (Number(candidate.duration) > 1200) score -= 2;
  return { score, why };
}

/** 兴趣画像写成人话，给日记和提示词用 */
export function describeTaste(state) {  const likes = state.topics.filter((t) => t.signal === 'like').sort((a, b) => b.stays - a.stays);
  const dislikes = state.topics.filter((t) => t.signal === 'dislike').sort((a, b) => b.skips - a.skips);
  const neutral = state.topics.filter((t) => t.signal === 'neutral');
  const lines = [];
  if (likes.length) lines.push('愿意多待：' + likes.slice(0, 8).map((t) => `${t.key}(${t.stays})`).join('、'));
  if (dislikes.length) lines.push('想划走：' + dislikes.slice(0, 8).map((t) => `${t.key}(${t.skips})`).join('、'));
  if (neutral.length) lines.push('说不好：' + neutral.slice(0, 8).map((t) => t.key).join('、'));
  const recent = state.decisions.slice(-5).reverse();
  if (recent.length) {
    lines.push('最近看过：');
    for (const d of recent) {
      const sign = d.kind === 'stay' ? '留下' : d.kind === 'skip' ? '划走' : '看完就算';
      lines.push(`- ${sign}《${d.title.slice(0, 40)}》— ${d.why.slice(0, 60)}`);
    }
  }
  return lines.length ? lines.join('\n') : '（还没摸出来）';
}
