// 核心测试：这个插件最重要的承诺是「没有新发现是合法结果」，
// 所以测试里必须证明：什么都不做也不会被任何逻辑判为失败。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { plan, wakePrompt, shDate, nowMin } from "../lib/clock.mjs";
import { pickSessionCwd } from "../lib/scheduler.mjs";
import { suggest } from "../lib/encounter.mjs";

function svc() {
  const dir = mkdtempSync(join(tmpdir(), "fishman-test-"));
  const s = new Service({ dataDir: dir });
  return { s, dir, done: () => { try { s.close() } catch {} rmSync(dir, { recursive: true, force: true }) } };
}

test("全新安装：没有任何读取、没有日记、没有信，status 仍然正常", () => {
  const { s, done } = svc();
  try {
    const st = s.status();
    assert.equal(st.journals.used, 0);
    assert.equal(st.journals.remaining, 2);
    assert.equal(st.letters.count, 0);
    assert.equal(st.pause, null);
    // 最重要的一条：明确告诉她"没发现也可以"
    assert.equal(st.posture.noDiscoveryIsFine, true);
  } finally { done() }
});

test("写入能力齐全，但默认全部关闭", () => {
  const { s, done } = svc();
  try {
    const st = s.status();
    // ⚠️ 这里断言的是**能力存在 + 默认关**，不是"没有能力"。
    //   主人 2026-10-22 明确要求：评论/弹幕/动态/点赞/投币/收藏/历史都得有，
    //   但可以不启用 —— 所以七项都要出现在 status 里，且默认 false ✓
    for (const k of [
      "history", "favorites", "likes", "coins",
      "comments", "danmaku", "dynamics",
    ]) {
      assert.equal(typeof st.writes[k], "boolean", `status 里要有 ${k}`);
      assert.equal(st.writes[k], false, `${k} 默认必须是 false`);
    }
    assert.equal(st.writes.registered.length, 7, "七个写入工具常驻注册");
    assert.deepEqual(st.writes.enabled, [], "默认一个都没启用");
    assert.match(st.writes.note, /缺一样/);
  } finally { done() }
});

test("候选捞不到时返回 mayBeNothing，而不是报错", async () => {
  const { s, done } = svc();
  try {
    // fetcher 永远返回空数据
    s.fetcher = async () => ({
      status: 200,
      headers: new Map([["content-length", "0"]]),
      body: (async function* () {
        yield Buffer.from(JSON.stringify({ code: 0, data: { result: [], list: [] } }));
      })(),
    });
    const r = await s.candidates(5);
    assert.deepEqual(r.result.candidates, []);
    assert.ok(r.result.mayBeNothing, "必须明确说这不是失败");
    assert.match(r.result.mayBeNothing, /不是失败/);
  } finally { done() }
});

test("suggest 不按播放量排序，偏好命中的优先", () => {
  const list = [
    { bvid: "BV0000000003", duration: 100, preferenceHit: null },
    { bvid: "BV0000000002", duration: 3000, preferenceHit: "猫咪" },
    { bvid: "BV0000000001", duration: 200, preferenceHit: "猫咪" },
  ];
  const out = suggest(list);
  assert.equal(out[0].preferenceHit, "猫咪");
  assert.equal(out[1].preferenceHit, "猫咪");
  // 两条都命中时，短的在前面（更容易真的看完）
  assert.equal(out[0].duration, 200);
  assert.equal(out[2].preferenceHit, null);
});

test("计划：时段都过了 → done，且措辞不说失败", () => {
  const cfg = { night: { windows: [{ start: "00:00", end: "00:30" }] } };
  const late = new Date("2026-10-22T15:00:00+08:00"); // 上海 15:00
  const p = plan(cfg, null, late);
  assert.equal(p.action, "done");
  assert.match(p.reason, /明天再说|过去了/);
});

test("计划：窗口内会给出一个可醒的时刻", () => {
  const cfg = { night: { windows: [{ start: "20:00", end: "23:00" }] } };
  const at = new Date("2026-10-22T19:00:00+08:00");
  const p = plan(cfg, null, at);
  assert.equal(p.action, "wake");
  assert.ok(p.at >= 20 * 60 && p.at < 23 * 60, `at=${p.at}`);
  assert.match(p.atText, /^\d{2}:\d{2}$/);
});

test("已经醒过 → 不会重复排（不刷屏）", () => {
  const cfg = { night: { windows: [{ start: "20:00", end: "23:00" }] } };
  const now = new Date("2026-10-22T21:00:00+08:00");
  const p = plan(cfg, { date: shDate(now), fired: true }, now);
  assert.equal(p.action, "done");
});

test("叫醒的话里没有九步清单，且明确说可以什么都不做", () => {
  const text = wakePrompt({ atText: "20:30", window: "20:00–23:00" }, {
    persona: { name: "助手", ownerTitle: "主人" },
  });
  assert.match(text, /不用做任何事/);
  assert.match(text, /什么都不做/);
  assert.match(text, /不是失败/);
  // 养鱼那套硬流程的关键词不该出现
  assert.doesNotMatch(text, /按 AGENTS\.md 的/);
  assert.doesNotMatch(text, /1\) `node bili\.mjs deps`/);
});

test("pickSessionCwd 选出的目录不与系统 temp 嵌套", () => {
  const dshHome = join(tmpdir(), "..", ".dsh-probe");
  const r = pickSessionCwd({ dshHome });
  const norm = (p) => p.replace(/[\\/]+$/, "").toLowerCase();
  const tmp = norm(tmpdir());
  const cwd = norm(r.cwd);
  const nested = cwd === tmp || cwd.startsWith(tmp + "\\") || cwd.startsWith(tmp + "/");
  assert.equal(nested, false, `cwd=${cwd} 与 temp=${tmp} 嵌套了`);
});

test("信：没有正文就拒绝，有正文就落地成本地文件", () => {
  const { s, done } = svc();
  try {
    assert.throws(() => s.letter({ body: "   " }), /LETTER_EMPTY/);
    const r = s.letter({ body: "今天看到一个人很认真地做一件很小的事。" });
    assert.equal(r.status, "local_letter_not_delivered");
    const all = s.letters();
    assert.equal(all.entries.length, 1);
    assert.match(all.text, /今天看到一个人/);
  } finally { done() }
});

test("日子：同一天可以覆盖，不累加成 KPI", () => {
  const { s, done } = svc();
  try {
    s.day({ date: "2026-10-22", mood: "平静", note: "什么都没看，但挺好" });
    s.day({ date: "2026-10-22", mood: "有点闷", note: "下午变了" });
    const days = s.days(10);
    assert.equal(days.length, 1, "同一天只能有一条");
    assert.equal(days[0].mood, "有点闷");
  } finally { done() }
});

test("账本坏了拒绝启动，不悄悄重建空账本", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "fishman-corrupt-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.initialized"), "schema=2\n");
    // 没有 ledger.sqlite，但有 marker → 必须拒绝
    assert.throws(() => new Service({ dataDir: dir }), /LEDGER_MISSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
