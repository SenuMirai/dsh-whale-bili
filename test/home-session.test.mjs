import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 测试要跑在一个假的 DSH_HOME 里：scheduler 用 process.env.DSH_HOME 找 life.json
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fishman-home-"));
process.env.DSH_HOME = home;
fs.mkdirSync(path.join(home, "worlds", "default"), { recursive: true });
fs.writeFileSync(path.join(home, "worlds", "default", "life.json"), JSON.stringify({ homeSessionId: "session-home-1" }));
fs.writeFileSync(path.join(home, "bili-fishman-night.json"), JSON.stringify({ date: "2000-01-01" }));

const { startClock, readHomeSessionId } = await import("../lib/scheduler.mjs");

function fakeCtx({ resolve = true } = {}) {
  const prompts = [];
  const created = [];
  const agents = new Map();
  return {
    ctx: {
      sessionController: {
        create: async ({ sessionId }) => { created.push(sessionId); return { sessionId }; },
        resolveAgent: async (id) => (resolve ? { agent: { id } } : { error: { code: "session/not-found", message: "没了" } }),
        prompt: async (req) => { prompts.push(req); return { accepted: true }; },
        selectModel: async () => {},
      },
      get: (name) => (name === "agents" ? { get: (id) => (prompts.length >= 0 ? undefined : undefined) } : undefined),
      agents: { get: () => undefined },
    },
    prompts,
    created,
  };
}

const service = { reload: () => ({ persona: { name: "蓝星钥", ownerTitle: "主人" }, night: { enabled: false } }) };

test("读过世界 life.json 才知道家会话是谁", () => {
  assert.equal(readHomeSessionId(home, "default"), "session-home-1");
  assert.equal(readHomeSessionId(home, "missing"), "");
});

test("叫醒发进家会话，而不是插件自建会话", async () => {
  const f = fakeCtx();
  const clock = startClock(f.ctx, { homeWorldId: "default", useHomeSession: true }, service);
  const out = await clock.wakeNow();
  clock.stop();
  assert.equal(out.sessionId, "session-home-1");
  assert.equal(out.wiredHome, true);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].sessionId, "session-home-1");
  assert.equal(f.created.length, 0, "不该去建自建会话");
});

test("家会话不在时退回自建会话，并把原因带出来", async () => {
  const f = fakeCtx({ resolve: false });
  const clock = startClock(f.ctx, { homeWorldId: "default", useHomeSession: true }, service);
  const out = await clock.wakeNow();
  clock.stop();
  assert.equal(out.sessionId, "bili-fishman");
  assert.equal(out.wiredHome, false);
  assert.ok(out.note, "要说清为什么没接上");
  assert.ok(f.created.includes("bili-fishman"), "退回时应该建/用自建会话");
});

test("关掉 useHomeSession 就明确回到自建会话", async () => {
  const f = fakeCtx();
  const clock = startClock(f.ctx, { homeWorldId: "default", useHomeSession: false }, service);
  const out = await clock.wakeNow();
  clock.stop();
  assert.equal(out.sessionId, "bili-fishman");
  assert.equal(out.wiredHome, false);
});
