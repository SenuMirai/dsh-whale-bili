// 两本日记的测试。
//
// 守的是主人要的两件事：
//   · 每天每本只有一篇（写第二遍是覆盖，不是流水账）
//   · 「今天就是很累，不想写」是合法的 —— 只有心情也算写过

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Diary, MAX_DIARY_CHARS } from "../lib/diary.mjs";
import { shDate } from "../lib/clock.mjs";

// 用真 Store：日记的日期、覆盖、封面都依赖 SQLite 的行为，
// 用假 store 测就等于测我自己写的假 store。
function mount() {
  const dir = mkdtempSync(join(tmpdir(), "fishman-diary-"));
  const store = new Store(dir);
  return {
    dir,
    store,
    diary: new Diary({ store }),
    // Windows 上 SQLite 句柄可能还占着文件，先关库再删，删不掉也不让测试挂掉。
    done() {
      try { store.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    },
  };
}

test("写一篇 open，读回来内容一致", () => {
  const m = mount();
  try {
    const r = m.diary.write("open", {
      mood: "有点累",
      body: "今天看了两条视频。\n第二条讲的是海边的小店，老板娘说今年的游客比往年少。",
    });
    assert.equal(r.kind, "open");
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.overwritten, false);
    assert.ok(r.id);
    assert.ok(r.created);

    const rows = m.diary.recent("open");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, r.date);
    assert.equal(rows[0].kind, "open");
    assert.equal(rows[0].mood, "有点累");
    assert.equal(
      rows[0].body,
      "今天看了两条视频。\n第二条讲的是海边的小店，老板娘说今年的游客比往年少。",
      "正文（含换行）要一字不差地读回来",
    );
  } finally { m.done(); }
});

test("同一天写第二次 → 覆盖，只有 1 条", () => {
  const m = mount();
  try {
    const first = m.diary.write("open", { mood: "乱", body: "第一遍，写得潦草" });
    const second = m.diary.write("open", { mood: "其实还好", body: "第二遍，想清楚了" });

    assert.equal(second.overwritten, true, "第二次写要标成覆盖");
    assert.equal(second.id, first.id, "同一天同一本还是同一篇，不新开一条");
    assert.equal(second.date, first.date);

    const rows = m.diary.recent("open");
    assert.equal(rows.length, 1, "一天只留一篇");
    assert.equal(rows[0].mood, "其实还好");
    assert.equal(rows[0].body, "第二遍，想清楚了", "留下的是后写的那篇");
  } finally { m.done(); }
});

test("两本日记互不干扰", () => {
  const m = mount();
  try {
    const openWrite = m.diary.write("open", {
      mood: "平静",
      body: "给主人看的：今天没什么事，挺好。",
    });
    const privWrite = m.diary.write("private", {
      mood: "其实有点烦",
      body: "偏好校准：那条讲猫的视频主人没反应，下次别往萌宠偏。",
    });

    const open = m.diary.recent("open");
    const priv = m.diary.recent("private");
    assert.equal(open.length, 1, "写私人那本不该在公开那本里多出一条");
    assert.equal(priv.length, 1);
    assert.match(open[0].body, /给主人看的/);
    assert.match(priv[0].body, /偏好校准/);
    assert.notEqual(openWrite.id, privWrite.id, "两本是两条独立的记录");

    // 同一天两本都写，互不覆盖
    m.diary.write("open", { mood: "平静", body: "给主人看的（改过）" });
    assert.match(m.diary.recent("private")[0].body, /偏好校准/, "改公开那本不该动到私人那本");
  } finally { m.done(); }
});

test(`正文超过 ${MAX_DIARY_CHARS} 字符 → DIARY_TOO_LONG`, () => {
  const m = mount();
  try {
    assert.throws(
      () => m.diary.write("open", { body: "字".repeat(MAX_DIARY_CHARS + 1) }),
      (e) => e.code === "DIARY_TOO_LONG",
    );
    assert.equal(m.diary.recent("open").length, 0, "被拒的那篇不该落库");

    // 正好到上限是可以的 —— 别把边界也拦掉
    const ok = m.diary.write("open", { body: "字".repeat(MAX_DIARY_CHARS) });
    assert.ok(ok.id);
    assert.equal(m.diary.recent("open").length, 1);
  } finally { m.done(); }
});

test("正文和心情都空 → DIARY_EMPTY；只有心情没正文要成功", () => {
  const m = mount();
  try {
    assert.throws(
      () => m.diary.write("open", { mood: "  ", body: "   " }),
      (e) => e.code === "DIARY_EMPTY",
    );
    assert.throws(
      () => m.diary.write("open", {}),
      (e) => e.code === "DIARY_EMPTY",
    );
    assert.equal(m.diary.recent("open").length, 0);

    // 「今天就是很累，不想写」是合法的一篇
    const r = m.diary.write("open", { mood: "就是很累，不想写" });
    const rows = m.diary.recent("open");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mood, "就是很累，不想写");
    assert.equal(rows[0].body, "", "只写心情就存空正文，别替她编话");
    assert.ok(r.date);
  } finally { m.done(); }
});

test("exportFile 生成的文件存在，含标题和日期", () => {
  const m = mount();
  try {
    const day = shDate();
    m.diary.write("open", { mood: "有点累", body: "今天看了两条视频，其中一条讲到海。" });
    m.diary.write("private", { mood: "烦躁", body: "偏好校准：萌宠那类下次少碰。" });

    // 还没导出过：设置页拿到的应是"文件不在"，不是旧内容
    assert.equal(m.diary.readFile("open").exists, false);

    const openPath = m.diary.exportFile("open");
    assert.equal(openPath, join(m.dir, "diary.md"));
    assert.ok(existsSync(openPath), "导出后文件要真的在");

    const openText = readFileSync(openPath, "utf8");
    assert.match(openText, /^# 她的日记（给主人看的）/);
    assert.match(openText, new RegExp(`## ${day} · 有点累`));
    assert.match(openText, /今天看了两条视频/);
    // 标题和第一条之间要有分隔线（主人能翻得下去）
    assert.match(openText, /\n---\n\n## /);

    const read = m.diary.readFile("open");
    assert.equal(read.exists, true);
    assert.equal(read.path, openPath);
    assert.equal(read.text, openText);

    // 私人那本是另一个文件、另一个标题
    const privPath = m.diary.exportFile("private");
    assert.equal(privPath, join(m.dir, "diary-private.md"));
    assert.notEqual(privPath, openPath);
    const privText = readFileSync(privPath, "utf8");
    assert.match(privText, /^# 她的日记（只给她自己）/);
    assert.match(privText, /偏好校准/);
    assert.doesNotMatch(privText, /今天看了两条视频/, "私人的那本不该混进公开正文");

    // 原子写不该留下半截 .tmp
    assert.equal(readdirSync(m.dir).filter((f) => f.endsWith(".tmp")).length, 0);
  } finally { m.done(); }
});

test("recent 按日期倒序", () => {
  const m = mount();
  try {
    // 插几天历史数据：recent 读的是"最近几天"，跟写入顺序无关
    const insert = m.store.db.prepare(
      "INSERT INTO diary(id, kind, date, mood, body, created) VALUES(?,?,?,?,?,?)",
    );
    for (const [i, date] of ["2026-10-19", "2026-10-21", "2026-10-20", "2026-10-22"].entries()) {
      insert.run(`seed-${i}`, "open", date, `m${i}`, `b${i}`, "2026-10-22T00:00:00.000Z");
    }

    const dates = m.diary.recent("open").map((r) => r.date);
    assert.deepEqual(dates, ["2026-10-22", "2026-10-21", "2026-10-20", "2026-10-19"]);

    assert.deepEqual(
      m.diary.recent("open", 2).map((r) => r.date),
      ["2026-10-22", "2026-10-21"],
      "n 要真的截断",
    );
    assert.equal(m.diary.recent("private").length, 0, "私人那本不该被 open 的数据污染");

    // 导出是正序（像日记一样往后翻）
    const text = readFileSync(m.diary.exportFile("open"), "utf8");
    assert.ok(text.indexOf("2026-10-19") < text.indexOf("2026-10-22"));
  } finally { m.done(); }
});

test("重复挂载安全；不认识的 kind 会被拒", () => {
  const m = mount();
  try {
    // 服务重启 / 设置页刷新会反复 new Diary，表已经在了也不能炸
    assert.doesNotThrow(() => new Diary({ store: m.store }));

    assert.throws(() => m.diary.write("public", { body: "x" }), (e) => e.code === "DIARY_KIND_INVALID");
    assert.throws(() => m.diary.recent("nope"), (e) => e.code === "DIARY_KIND_INVALID");
    assert.throws(() => m.diary.exportFile("nope"), (e) => e.code === "DIARY_KIND_INVALID");
    assert.throws(() => m.diary.readFile("nope"), (e) => e.code === "DIARY_KIND_INVALID");
  } finally { m.done(); }
});
