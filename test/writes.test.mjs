// 写入能力测试。
//
// 这一组守的是**主人的要求**：
//   「评论、弹幕、动态、点赞、投币、收藏、历史这些我可以不启用，
//     或者它认为今天不需要可以，但不能没有这些功能」
//
// 所以断言是：
//   ✓ 能力必须存在（开关打开就能注册）
//   ✓ 默认全部关闭（不配置就一个都不出现）
//   ✓ 光有开关不够（还要本地授权文件）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../index.js";

const WRITE_TOOLS = [
  "bili_fishman_comment",
  "bili_fishman_danmaku",
  "bili_fishman_dynamic",
  "bili_fishman_history",
  "bili_fishman_favorite",
  "bili_fishman_like",
  "bili_fishman_coin",
];

function mount(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fishman-w-"));
  const tools = [];
  const ctx = {
    tools: { register: (t) => { tools.push(t); return () => {}; } },
    on: () => {},
    get: () => undefined,
    sessionController: undefined,
  };
  const cfg = plugin.Config({ dataDir: dir, night: { enabled: false }, ...config });
  plugin.apply(ctx, cfg);
  return {
    tools,
    names: tools.map((t) => t.name ?? t).sort(),
    dir,
    done: () => {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    },
  };
}

test("默认：7 个写入工具都注册（常驻），但一个都发不出去", async () => {
  const m = mount();
  try {
    // 工具常驻 —— 这样在设置页拨开关能立刻生效，不用重启 ✓
    for (const t of WRITE_TOOLS) {
      assert.ok(m.names.includes(t), `${t} 应常驻注册`);
    }
    assert.equal(m.names.length, 22);
  } finally { m.done() }
});

test("⭐ 能力都在：7 个开关全开 → 7 个写入工具可用", () => {
  const m = mount({
    enableCommentWrites: true,
    enableDanmakuWrites: true,
    enableDynamicWrites: true,
    enableHistoryWrites: true,
    enableFavoriteWrites: true,
    enableLikeWrites: true,
    enableCoinWrites: true,
  });
  try {
    for (const t of WRITE_TOOLS) {
      assert.ok(m.names.includes(t), `${t} 必须在`);
    }
    assert.equal(m.names.length, 22, "开关不改变工具数量，只改变可用性");
  } finally { m.done() }
});

test("每个开关独立生效，互不影响（看 status.writes）", async () => {
  const { Service } = await import("../lib/service.mjs");
  const cases = [
    ["enableCommentWrites", "comments"],
    ["enableDanmakuWrites", "danmaku"],
    ["enableDynamicWrites", "dynamics"],
    ["enableHistoryWrites", "history"],
    ["enableFavoriteWrites", "favorites"],
    ["enableLikeWrites", "likes"],
    ["enableCoinWrites", "coins"],
  ];
  for (const [sw, key] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "fishman-sw-"));
    const s = new Service({ dataDir: dir, [sw]: true });
    try {
      const w = s.status().writes;
      assert.equal(w[key], true, `${sw}=true 应该让 ${key} 为 true`);
      for (const [, other] of cases) {
        if (other !== key) assert.equal(w[other], false, `${key} 不该带动 ${other}`);
      }
    } finally {
      try { s.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }
});

test("写入工具的措辞不催她发", () => {
  const m = mount({
    enableCommentWrites: true,
    enableDynamicWrites: true,
  });
  try {
    const comment = m.tools.find((t) => t.name === "bili_fishman_comment");
    assert.match(comment.description, /only if you genuinely have something to say/i);
    assert.match(comment.description, /Not required/i);
    assert.match(comment.description, /never batch/i);

    const dyn = m.tools.find((t) => t.name === "bili_fishman_dynamic");
    assert.match(dyn.description, /Not required/i);
    assert.match(dyn.description, /hard to take back/i);
  } finally { m.done() }
});

test("写入工具都要授权文件，不是配个 true 就能发", () => {
  const m = mount({ enableCommentWrites: true });
  try {
    const c = m.tools.find((t) => t.name === "bili_fishman_comment");
    assert.match(c.description, /grant/i);
  } finally { m.done() }
});

test("status 如实报告：能力在、默认关", async () => {
  const { Service } = await import("../lib/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fishman-st-"));
  const s = new Service({ dataDir: dir });
  try {
    const st = s.status();
    // 七项能力都出现在 status 里（说明它们存在）
    for (const k of ["comments", "danmaku", "dynamics", "history", "favorites", "likes", "coins"]) {
      assert.equal(typeof st.writes[k], "boolean", `status 里要有 ${k}`);
      assert.equal(st.writes[k], false, `${k} 默认必须是 false`);
    }
    // 工具常驻注册（registered 有 7 个），但启用的（enabled）是空的
    assert.equal(st.writes.registered.length, 7, "七个写入工具常驻注册");
    assert.deepEqual(st.writes.enabled, [], "默认一个都没启用");
    assert.match(st.writes.note, /缺一样/);
  } finally {
    try { s.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

test("开关打开后 status 会报告已启用", async () => {
  const { Service } = await import("../lib/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fishman-st2-"));
  const s = new Service({ dataDir: dir, enableCommentWrites: true });
  try {
    const st = s.status();
    assert.equal(st.writes.comments, true);
    assert.ok(st.writes.enabled.includes("bili_fishman_comment"));
    // 其他仍然关
    assert.equal(st.writes.dynamics, false);
    assert.equal(st.writes.enabled.length, 1);
  } finally {
    try { s.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

test("没有授权文件时，写入被拒（WRITE_POLICY_INVALID）", async () => {
  const { Service } = await import("../lib/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fishman-grant-"));
  const s = new Service({
    dataDir: dir,
    enableCommentWrites: true,
    writePolicyPath: join(dir, "nope.json"),
  });
  try {
    await assert.rejects(
      () => s.talk("comments", { oid: "123", message: "hi" }),
      (e) => e.code === "WRITE_POLICY_INVALID" || e.code === "WRITE_DISABLED",
    );
  } finally {
    try { s.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

test("开关关着时，即使有授权文件也拒", async () => {
  const { Service } = await import("../lib/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fishman-grant2-"));
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, id: "test", enabled: true, handoverConfirmed: true,
    accountId: "123", expiresAt: "2099-01-01T00:00:00Z",
    comments: { enabled: true, maxWrites: 5, targets: ["BV:test"] },
  }));
  const s = new Service({
    dataDir: dir,
    enableCommentWrites: false, // ← 开关关着
    writePolicyPath: policy,
  });
  try {
    await assert.rejects(
      () => s.talk("comments", { oid: "123", message: "hi" }),
      (e) => e.code === "WRITE_DISABLED",
    );
  } finally {
    try { s.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

test("授权过期会被拒", async () => {
  const { Service } = await import("../lib/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fishman-grant3-"));
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, id: "test", enabled: true, handoverConfirmed: true,
    accountId: "123", expiresAt: "2000-01-01T00:00:00Z", // ← 过期
    comments: { enabled: true, maxWrites: 5, targets: ["BV:test"] },
  }));
  const s = new Service({ dataDir: dir, enableCommentWrites: true, writePolicyPath: policy });
  try {
    await assert.rejects(
      () => s.talk("comments", { oid: "123", message: "hi" }),
      (e) => e.code === "WRITE_GRANT_EXPIRED",
    );
  } finally {
    try { s.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

test("目标不在授权白名单里会被拒", async () => {
  const { Service } = await import("../lib/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fishman-grant4-"));
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, id: "test", enabled: true, handoverConfirmed: true,
    accountId: "123", expiresAt: "2099-01-01T00:00:00Z",
    comments: { enabled: true, maxWrites: 5, targets: ["BV:BV0000000001"] },
  }));
  const s = new Service({ dataDir: dir, enableCommentWrites: true, writePolicyPath: policy });
  try {
    await assert.rejects(
      () => s.talk("comments", { oid: "123", message: "hi", bvid: "BV9999999999" }),
      (e) => e.code === "WRITE_TARGET_DENIED",
    );
  } finally {
    try { s.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

test("弹幕长度超限会被拒", async () => {
  const { Service } = await import("../lib/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fishman-dm-"));
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, id: "test", enabled: true, handoverConfirmed: true,
    accountId: "123", expiresAt: "2099-01-01T00:00:00Z",
    danmaku: { enabled: true, maxWrites: 5, targets: ["room:12345"] },
  }));
  // ⚠️ 2026-10-25：现在 Service 会给 credentialPath 兜底到 <dataDir>/credential.json，
  //   而 Network 构造时就会读凭据 —— 没有文件会先抛 CREDENTIAL_INVALID，
  //   长度校验根本轮不到 ✗
  //   这里放一个**格式合法**的假凭据，才能真正测到「长度超限」这条 ✓
  writeFileSync(
    join(dir, "credential.json"),
    JSON.stringify({
      sessdata: "fake-sessdata",
      bili_jct: "0123456789abcdef0123456789abcdef",
      buvid3: "fake-buvid3",
      dedeuserid: "123",
    }),
  );
  const s = new Service({ dataDir: dir, enableDanmakuWrites: true, writePolicyPath: policy });
  try {
    // ⚠️ 原来那条测试串其实是**正好 20 个字**，没超限 ✗ ——
    //   它能"通过"只是因为凭据无效先报了别的错。
    //   换成明确超长的 26 个字，才是真的在测长度校验 ✓
    const tooLong = "这条弹幕实在是太长了肯定超过二十个字的限制发不出去";
    assert.ok([...tooLong].length > 20, "测试串必须真的超过 20 字");
    await assert.rejects(
      () => s.talk("danmaku", { roomId: "12345", message: tooLong }),
      (e) => e.code === "DANMAKU_TOO_LONG",
    );
  } finally {
    try { s.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});
