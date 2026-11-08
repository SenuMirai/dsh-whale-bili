// 工具契约测试：确认注册了哪些工具、**没有**注册哪些工具。
// 这个测试是整件事的护栏：如果哪天有人加了写入工具，这里必须红。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../index.js";

function mount(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fishman-tools-"));
  const tools = [];
  const ctx = {
    tools: {
      register: (t) => {
        tools.push(t);
        return () => {};
      },
    },
    on: () => {},
    get: () => undefined,
    sessionController: undefined, // 让 scheduler 不真的跑
  };
  // 与 DSH 一致：先过一遍 Config schema，再交给 apply
  const cfg = plugin.Config({ dataDir: dir, night: { enabled: false }, ...config });
  plugin.apply(ctx, cfg);
  return {
    tools,
    names: tools.map((t) => t.name ?? t).sort(),
    // Windows 上 SQLite 文件句柄没放掉时 rmSync 会 EPERM；
    // 测试目录放临时区无所谓残留，尽力清理即可 ✓
    done: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* 句柄还占着就算了，系统临时区会自己回收 */
      }
    },
  };
}

test("默认注册 18 个工具（11 个看/记 + 7 个写入常驻）", () => {
  const m = mount();
  try {
    assert.equal(m.names.length, 18, `实际：${m.names.join(", ")}`);
  } finally { m.done() }
});

test("注册的工具名与清单一致", () => {
  const m = mount();
  try {
    assert.deepEqual(m.names, [
      "bili_fishman_cancel",
      "bili_fishman_candidates",
      "bili_fishman_coin",
      "bili_fishman_comment",
      "bili_fishman_comment_digest",
      "bili_fishman_danmaku",
      "bili_fishman_decide",
      "bili_fishman_dynamic",
      "bili_fishman_favorite",
      "bili_fishman_history",
      "bili_fishman_import",
      "bili_fishman_inbox",
      "bili_fishman_like",
      "bili_fishman_read",
      "bili_fishman_reply_draft",
      "bili_fishman_source",
      "bili_fishman_status",
      "bili_fishman_taste",
    ]);
  } finally { m.done() }
});

/**
 * 2026-11-08：日记、信、信笺、日子、人格札记全部搬去世界插件。
 * 这里守住「不许再长回来」—— 长回来就又变成两本记忆。
 */
test("⭐ 日记/信/信笺不许再注册回来（世界是记忆中心）", () => {
  const m = mount({ enablePersonalityLearning: true });
  try {
    for (const gone of [
      "bili_fishman_diary",
      "bili_fishman_diaries",
      "bili_fishman_letter",
      "bili_fishman_letters",
      "bili_fishman_journal",
      "bili_fishman_guide",
      "bili_fishman_day",
      "bili_fishman_days",
      "bili_fishman_personality",
      "bili_fishman_memory",
    ]) {
      assert.equal(m.names.includes(gone), false, gone + " 已经搬去世界了，不该还在这里");
    }
  } finally { m.done() }
});

test("⭐ 七个写入工具常驻注册（改了开关立刻能用，不用重启）", () => {
  const m = mount();
  try {
    const writeTools = [
      "bili_fishman_comment", "bili_fishman_danmaku", "bili_fishman_dynamic",
      "bili_fishman_history", "bili_fishman_favorite", "bili_fishman_like",
      "bili_fishman_coin",
    ];
    for (const t of writeTools) {
      assert.ok(m.names.includes(t), `${t} 必须常驻注册`);
    }
  } finally { m.done() }
});

test("⭐ 但默认一个都发不出去（开关关着 → WRITE_DISABLED）", async () => {
  const { Service } = await import("../lib/service.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fishman-default-"));
  const s = new Service({ dataDir: dir });
  try {
    // 工具在，但调用被拒
    await assert.rejects(
      () => s.talk("comments", { oid: "123", message: "hi" }),
      (e) => e.code === "WRITE_DISABLED",
      "默认必须拒发",
    );
    await assert.rejects(
      () => s.platformWrite("likes", { readingId: "x" }),
      (e) => e.code === "WRITE_DISABLED",
    );
  } finally {
    try { s.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});



test("每个工具都有 description 和 parameters", () => {
  const m = mount();
  try {
    for (const t of m.tools) {
      assert.ok(t.name, "工具必须有 name");
      assert.ok(
        typeof t.description === "string" && t.description.length > 20,
        `${t.name} 的 description 太短`,
      );
      assert.ok(t.parameters && typeof t.parameters === "object", `${t.name} 缺 parameters`);
    }
  } finally { m.done() }
});



test("candidates 工具的说明里写明找不到是正常结果", () => {
  const m = mount();
  try {
    const c = m.tools.find((t) => t.name === "bili_fishman_candidates");
    assert.match(c.description, /Finding nothing is a normal result/);
  } finally { m.done() }
});
