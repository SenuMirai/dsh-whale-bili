// 活动账本 —— 「她到底做了什么」的唯一可查记录。
//
// 为什么必须有这个模块（2026-10-22 主人的批评）：
//   设置页当时只有「读过的 N 条」这种计数，看不到**具体哪条视频、发了什么评论、
//   点了谁的赞**。于是"测试"跑完一片绿，主人却什么都验证不了 ✗
//   这不是测试不准，是**没有可验证的痕迹** ✗
//
// 设计上的两个取舍：
//   1. **只记发生过的事，不记意图**。发失败也要记（status='failed'），
//      因为"她尝试过什么"和"什么没成功"同样是主人该知道的 ✓
//   2. **链接用 B 站原始 URL**，不用插件内部 id —— 主人点开要能直接看到东西 ✓

import { randomUUID } from "node:crypto";

/** 允许的活动类型。写错类型是 bug，应该在开发期就暴露，而不是静静存进去。 */
export const KINDS = [
  "read",      // 读了某个视频
  "comment",   // 发了评论
  "danmaku",   // 发了弹幕
  "dynamic",   // 发了动态
  "like",      // 点赞
  "coin",      // 投币
  "favorite",  // 收藏
  "history",   // 上报观看进度
  "listen",    // 监听到有人找她
  "letter",    // 写了信
  "journal",   // 写了信笺
  "diary",     // 写了日记
  "test",      // 自检产生的动作（要能跟真实产出区分开）
];

const MAX_ROWS = 5000;

/**
 * 建表。用 IF NOT EXISTS 而不是改 user_version ——
 * 那样老账本能直接升级，不需要迁移脚本，也不会因为版本号对不上而拒绝启动 ✓
 */
export function ensure(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok',
      link TEXT NOT NULL DEFAULT '',
      is_test INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);
    CREATE INDEX IF NOT EXISTS activity_kind ON activity(kind, at DESC);
  `);
}

/**
 * 记一条。
 *
 * ⚠️ 这个函数**永远不该抛错**。活动账本是"附加信息"，
 *   记失败不能让已经发出去的评论变成"调用失败" —— 那会让上层误判要不要重试 ✗
 */
export function record(store, entry = {}) {
  try {
    ensure(store);
    const kind = String(entry.kind ?? "");
    if (!KINDS.includes(kind)) return null;
    const row = {
      id: randomUUID(),
      at: entry.at || new Date().toISOString(),
      kind,
      target: String(entry.target ?? "").slice(0, 200),
      title: String(entry.title ?? "").slice(0, 300),
      detail: String(entry.detail ?? "").slice(0, 2000),
      status: String(entry.status ?? "ok").slice(0, 40),
      link: String(entry.link ?? "").slice(0, 400),
      is_test: entry.isTest ? 1 : 0,
    };
    store.db
      .prepare(
        "INSERT INTO activity (id,at,kind,target,title,detail,status,link,is_test) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(row.id, row.at, row.kind, row.target, row.title, row.detail, row.status, row.link, row.is_test);
    // 老的自动裁掉：这表只用于"最近做了什么"，不是归档库 ✓
    store.db
      .prepare("DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY at DESC LIMIT -1 OFFSET ?)")
      .run(MAX_ROWS);
    return row;
  } catch {
    return null;
  }
}

/** 最近的活动。kind 传数组表示"这几类都要"。 */
export function recent(store, { limit = 50, kind = null } = {}) {
  try {
    ensure(store);
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const kinds = kind == null ? null : Array.isArray(kind) ? kind : [kind];
    if (kinds && !kinds.length) return [];
    const sql = kinds
      ? `SELECT * FROM activity WHERE kind IN (${kinds.map(() => "?").join(",")}) ORDER BY at DESC, id DESC LIMIT ?`
      : "SELECT * FROM activity ORDER BY at DESC, id DESC LIMIT ?";
    const args = kinds ? [...kinds, n] : [n];
    return store.db.prepare(sql).all(...args).map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      target: r.target,
      title: r.title,
      detail: r.detail,
      status: r.status,
      link: r.link,
      isTest: r.is_test === 1,
    }));
  } catch {
    return [];
  }
}

/** 给 status / 设置页用的汇总：每一类各有几条 */
export function summary(store) {
  try {
    ensure(store);
    const rows = store.db
      .prepare("SELECT kind, count(*) AS n FROM activity GROUP BY kind")
      .all();
    const out = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const r of rows) out[r.kind] = r.n;
    return out;
  } catch {
    return Object.fromEntries(KINDS.map((k) => [k, 0]));
  }
}

/** B 站视频链接（活动账本里统一用它，主人点开就能看）*/
export function videoLink(bvid) {
  const bv = String(bvid ?? "").trim();
  return /^BV[0-9A-Za-z]{10}$/.test(bv) ? `https://www.bilibili.com/video/${bv}/` : "";
}
