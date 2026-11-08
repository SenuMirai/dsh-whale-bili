// 配置形状测试。
//
// 为什么单独测这个：设置页的每个输入框背后都对应一个 Config 字段。
// 如果 schemastery 把某个字段**静默丢掉**（z.object 默认会剥掉未声明的键），
// 表现就是"界面能填、保存成功、但重启后没了"——最难查的那类 bug ✗
// 所以这里把「界面能改的字段」逐个断言它们真的留在解析结果里 ✓

import { test } from "node:test";
import assert from "node:assert/strict";
import * as plugin from "../index.js";

const parse = (raw) => plugin.Config(raw);

test("模型选择字段能落到配置里", () => {
  const c = parse({
    dataDir: "C:/tmp/x",
    model: { provider: "workbuddy", model: "hy3", reasoningEffort: "high" },
  });
  assert.equal(c.model.provider, "workbuddy");
  assert.equal(c.model.model, "hy3");
  assert.equal(c.model.reasoningEffort, "high");
});

test("主人信息能落到配置里（分享 @ 用）", () => {
  const c = parse({
    dataDir: "C:/tmp/x",
    owner: { mid: "28645724", name: "示例用户" },
  });
  assert.equal(c.owner.mid, "28645724");
  assert.equal(c.owner.name, "示例用户");
});

test("⭐ 倾听额度默认值正确", () => {
  const L = parse({ dataDir: "C:/tmp/x" }).listen;
  assert.equal(L.enabled, false, "默认不开启监听");
  assert.equal(L.intervalSec, 300, "默认 5 分钟看一次");
  assert.equal(L.dailyMax, 10, "全天最多 10 条");
  assert.equal(L.perPersonMax, 2, "同一个人最多 2 条");
  assert.equal(L.perPersonDays, 30, "同一人观察窗口 30 天");
  assert.equal(L.perVideoMax, 3, "同一视频最多 3 条");
  assert.equal(L.allDay, false);
  assert.equal(L.scope, "both");
});

test("倾听额度能被覆盖（设置页保存的就是这些）", () => {
  const L = parse({
    dataDir: "C:/tmp/x",
    listen: {
      enabled: true,
      intervalSec: 120,
      dailyMax: 5,
      perPersonMax: 1,
      perPersonDays: 7,
      perVideoMax: 2,
      allDay: true,
      scope: "reply",
    },
  }).listen;
  assert.equal(L.enabled, true);
  assert.equal(L.intervalSec, 120);
  assert.equal(L.dailyMax, 5);
  assert.equal(L.perPersonMax, 1);
  assert.equal(L.perPersonDays, 7);
  assert.equal(L.perVideoMax, 2);
  assert.equal(L.allDay, true);
  assert.equal(L.scope, "reply");
});

test("七项写入开关默认全关（配置层面）", () => {
  const c = parse({ dataDir: "C:/tmp/x" });
  for (const k of [
    "enableCommentWrites",
    "enableDanmakuWrites",
    "enableDynamicWrites",
    "enableHistoryWrites",
    "enableFavoriteWrites",
    "enableLikeWrites",
    "enableCoinWrites",
  ]) {
    assert.equal(c[k], false, `${k} 必须默认 false`);
  }
});

test("分享默认开、人格默认可学", () => {
  const c = parse({ dataDir: "C:/tmp/x" });
  assert.equal(c.share.enabled, true);
  assert.equal(c.enablePersonalityLearning, true);
});

test("只读项不会被 config 覆盖掉（它们在 Cordis 配置里，不在覆盖白名单）", () => {
  const c = parse({
    dataDir: "C:/tmp/x",
    credentialPath: "C:/tmp/x/cred.json",
    writePolicyPath: "C:/tmp/x/policy.json",
    maxSessionTokens: 123456,
  });
  assert.equal(c.credentialPath, "C:/tmp/x/cred.json");
  assert.equal(c.writePolicyPath, "C:/tmp/x/policy.json");
  assert.equal(c.maxSessionTokens, 123456);
});

test("⭐ 配置被冲掉也不能失能：路径没配就兜底到 dataDir", async () => {
  // 2026-10-25 的真实事故：DSH 改设置时重写了 profile 的 cordis.patch.yml，
  // 把本插件整段配置冲掉 → credentialPath 变空 → 扫码登录报
  // 「没有配置 credentialPath」✗
  // 插件不该因为配置文件被别的程序重写就整件事失能。
  const { Service } = await import("../lib/service.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fishman-fallback-"));
  try {
    // 故意什么都不配（模拟配置被冲干净）
    const s = new Service({ dataDir: dir });
    try {
      assert.equal(s.baseConfig.credentialPath, join(dir, "credential.json"), "凭据路径要兜底");
      assert.equal(s.baseConfig.writePolicyPath, join(dir, "write-policy.json"), "授权路径要兜底");
      assert.equal(s.config.credentialPath, s.baseConfig.credentialPath, "生效配置也要带上");
    } finally {
      try { s.close() } catch {}
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
});

test("显式配了路径就用配置的，不被兜底覆盖", async () => {
  const { Service } = await import("../lib/service.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fishman-explicit-"));
  try {
    const s = new Service({
      dataDir: dir,
      credentialPath: "C:/custom/cred.json",
      writePolicyPath: "C:/custom/policy.json",
    });
    try {
      assert.equal(s.baseConfig.credentialPath, "C:/custom/cred.json");
      assert.equal(s.baseConfig.writePolicyPath, "C:/custom/policy.json");
    } finally {
      try { s.close() } catch {}
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
});

test("⭐ 配置被冲掉也不能失能：路径没配就兜底到 dataDir", async () => {
  // 2026-10-25 的真实事故：DSH 改设置时重写了 profile 的 cordis.patch.yml，
  // 把本插件整段配置冲掉 → credentialPath 变空 → 扫码登录报
  // 「没有配置 credentialPath」✗
  // 插件不该因为配置文件被别的程序重写就整件事失能。
  const { Service } = await import("../lib/service.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fishman-fallback-"));
  try {
    // 故意什么都不配（模拟配置被冲干净）
    const s = new Service({ dataDir: dir });
    try {
      assert.equal(s.baseConfig.credentialPath, join(dir, "credential.json"), "凭据路径要兜底");
      assert.equal(s.baseConfig.writePolicyPath, join(dir, "write-policy.json"), "授权路径要兜底");
      assert.equal(s.config.credentialPath, s.baseConfig.credentialPath, "生效配置也要带上");
    } finally {
      try { s.close() } catch {}
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
});

test("显式配了路径就用配置的，不被兜底覆盖", async () => {
  const { Service } = await import("../lib/service.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fishman-explicit-"));
  try {
    const s = new Service({
      dataDir: dir,
      credentialPath: "C:/custom/cred.json",
      writePolicyPath: "C:/custom/policy.json",
    });
    try {
      assert.equal(s.baseConfig.credentialPath, "C:/custom/cred.json");
      assert.equal(s.baseConfig.writePolicyPath, "C:/custom/policy.json");
    } finally {
      try { s.close() } catch {}
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
});
