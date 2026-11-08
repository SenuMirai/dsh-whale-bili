// 回复策略测试。
//
// 主人 2026-10-22 的要求：
//   「它回复别人可以不经过我审核（可选开关），但我也可以自定义设置安全词，
//     涉及这些话题的不回复」
//
// 两条语义必须同时成立，而且**安全词优先级更高**：
//   连"免审核"也不能绕过安全词 —— 否则安全词就是摆设 ✗
//
// 另外这一组还守着活动账本：主人抱怨过"看不到她发了什么"，
// 而当时的真因是 kind 命名不一致（comments vs comment），记录被白名单静默拒掉 ✗

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import * as activity from "../lib/activity.mjs";

function svc(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fishman-reply-"));
  const s = new Service({ dataDir: dir, ...extra });
  return {
    s,
    done: () => {
      try { s.close() } catch {}
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
    },
  };
}

test("安全词默认空 = 不拦任何回复", async () => {
  const { s, done } = svc({ reply: { autoApprove: false, safetyWords: [] } });
  try {
    const r = await s.submitReply({ oid: "1", rpid: "2", message: "你好" });
    assert.equal(r.action, "drafted", "没设安全词就应该进待审队列");
  } finally { done() }
});

test("⭐ 对方说的话命中安全词 → 直接拒，连草稿都不进", async () => {
  const { s, done } = svc({ reply: { autoApprove: false, safetyWords: ["政治"] } });
  try {
    const r = await s.submitReply({
      oid: "1", rpid: "2",
      message: "我觉得挺好的",
      incoming: "你对这个政治事件怎么看",
    });
    assert.equal(r.action, "blocked");
    assert.equal(r.reason, "SAFETY_WORD");
    assert.equal(r.word, "政治");
    assert.equal(s.draftList().length, 0, "被安全词拦下不该留草稿");
  } finally { done() }
});

test("⭐ 她自己要说的正文命中也拦（不只看对方的话）", async () => {
  const { s, done } = svc({ reply: { autoApprove: false, safetyWords: ["代购"] } });
  try {
    const r = await s.submitReply({ oid: "1", rpid: "2", message: "我帮你去代购吧", incoming: "求推荐" });
    assert.equal(r.action, "blocked");
    assert.equal(r.word, "代购");
  } finally { done() }
});

test("⭐ 免审核也不能绕过安全词（优先级）", async () => {
  const { s, done } = svc({ reply: { autoApprove: true, safetyWords: ["加微信"] } });
  try {
    const r = await s.submitReply({ oid: "1", rpid: "2", message: "加微信聊", incoming: "怎么联系" });
    assert.equal(r.action, "blocked", "免审核开着也必须被安全词拦住");
    assert.equal(r.reason, "SAFETY_WORD");
  } finally { done() }
});

test("免审核关着 → 进待审队列", async () => {
  const { s, done } = svc({ reply: { autoApprove: false, safetyWords: [] } });
  try {
    const r = await s.submitReply({ oid: "1", rpid: "2", message: "谢谢你的分享", incoming: "看看这个" });
    assert.equal(r.action, "drafted");
    assert.equal(s.draftList().length, 1);
  } finally { done() }
});

test("安全词大小写不敏感", async () => {
  const { s, done } = svc({ reply: { autoApprove: false, safetyWords: ["Spam"] } });
  try {
    const r = await s.submitReply({ oid: "1", rpid: "2", message: "hi", incoming: "buy this SPAM now" });
    assert.equal(r.action, "blocked");
  } finally { done() }
});

test("⭐ 活动账本：安全词拦截也要留痕（能看到为什么没回）", async () => {
  const { s, done } = svc({ reply: { autoApprove: false, safetyWords: ["广告"] } });
  try {
    await s.submitReply({ oid: "1", rpid: "2", message: "x", incoming: "这是广告" });
    const acts = s.activities({ limit: 10 });
    const hit = acts.find((a) => a.status === "blocked_safety_word");
    assert.ok(hit, "拦截也必须进活动账本");
    assert.match(hit.detail, /广告/);
  } finally { done() }
});

test("活动账本：日记 / 信 都会被记录", async () => {
  const { s, done } = svc();
  try {
    s.diaryWrite("open", { mood: "平静", body: "今天还行" });
    s.letter({ body: "想跟你说句话" });
    const kinds = s.activities({ limit: 10 }).map((a) => a.kind);
    assert.ok(kinds.includes("diary"));
    assert.ok(kinds.includes("letter"));
    const sum = s.activitySummary();
    assert.equal(sum.diary, 1);
    assert.equal(sum.letter, 1);
  } finally { done() }
});

test("⭐ 活动账本：写入接口的复数名会被映射成单数（曾经的 bug）", () => {
  const { s, done } = svc();
  try {
    // 模拟 talk 的记录路径：复数 kind 经映射后应能落库
    const mapped = { comments: "comment", likes: "like", coins: "coin", favorites: "favorite", dynamics: "dynamic" };
    for (const [plural, singular] of Object.entries(mapped)) {
      // 直接传复数会被白名单拒 —— 这是设计（防止写错类型静默入库）
      assert.equal(activity.record(s.store, { kind: plural, title: "x" }), null, plural + " 不该直接被接受");
      // 映射成单数就能进
      assert.ok(activity.record(s.store, { kind: singular, title: "x" }), singular + " 应该能落库");
    }
  } finally { done() }
});

test("活动账本：坏数据不抛错（记账失败不能影响已发出的动作）", () => {
  const { s, done } = svc();
  try {
    assert.equal(activity.record(s.store, { kind: "不存在的类型" }), null);
    assert.deepEqual(activity.recent(s.store, { limit: 0 }), []);
  } finally { done() }
});
