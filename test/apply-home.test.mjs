import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 用假 DSH_HOME，把 apply() 真跑一遍：注册工具、挂路由、起生物钟。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fishman-apply-"));
process.env.DSH_HOME = home;
const dataDir = path.join(home, "bili-fishman");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
  persona: { name: "蓝星钥", ownerTitle: "主人" },
  night: { enabled: false },
}));
fs.mkdirSync(path.join(home, "worlds", "default"), { recursive: true });
fs.writeFileSync(path.join(home, "worlds", "default", "life.json"), JSON.stringify({ homeSessionId: "session-home-1" }));

const { apply } = await import("../index.js");

function harness() {
  const tools = new Map();
  const routes = new Map();
  const prompts = [];
  const listeners = new Map();
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    sessionController: {
      create: async () => ({ sessionId: "bili-fishman" }),
      resolveAgent: async (id) => ({ agent: { id } }),
      prompt: async (req) => { prompts.push(req); return { accepted: true }; },
      selectModel: async () => {},
    },
    get: (name) => (name === "agents" ? { get: () => undefined } : undefined),
    agents: { get: () => undefined },
    workingDirectory: { get: () => undefined, set: async () => {} },
    webServer: {
      register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); },
      getOrigin: () => "http://127.0.0.1:1",
    },
    connection: { requestRejection: () => undefined },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
    effect: () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, routes, prompts, listeners };
}

function callRoute(handler, method = "GET", body) {
  const chunks = [];
  const req = {
    method,
    url: "/x",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    on(event, fn) {
      if (event === "data" && body !== undefined) fn(Buffer.from(JSON.stringify(body)));
      if (event === "end") fn();
      return req;
    },
  };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader() {},
    end(payload) { chunks.push(payload); },
  };
  return Promise.resolve(handler(req, res)).then(() => {
    const raw = chunks.join("");
    return { status: res.statusCode, json: raw ? JSON.parse(raw) : null };
  });
}

test("apply() 真跑一遍：工具、设置路由、状态路由都在，且状态里写明接入的家会话", async () => {
  const h = harness();
  apply(h.ctx, { night: { enabled: false } });
  await new Promise((r) => setTimeout(r, 50));

  // 关键工具都在
  for (const name of ["bili_fishman_candidates", "bili_fishman_read", "bili_fishman_decide", "bili_fishman_status"]) {
    assert.ok(h.tools.has(name), "缺工具 " + name);
  }

  // 状态接口：要说得出「接入的是哪个她」
  const status = await callRoute(h.routes.get("/bili-fishman/api/status"));
  assert.equal(status.json.ok, true);
  assert.ok(status.json.session, "状态里必须有 session 这一段");
  assert.equal(status.json.session.homeWorldId, "default");
  assert.equal(typeof status.json.session.sessionId, "string");

  // 手动叫醒：真的往家会话发了一轮
  const wake = await callRoute(h.routes.get("/bili-fishman/api/wake-now"), "POST", {});
  assert.equal(wake.json.ok, true);
  assert.equal(wake.json.sessionId, "session-home-1");
  assert.equal(wake.json.wiredHome, true);
  const sent = h.prompts.at(-1);
  assert.equal(sent.sessionId, "session-home-1");
  assert.match(sent.content[0].text, /【醒了】/);

  // 收工：把生物钟停掉（插件自己的 dispose 就是干这个的）
  h.listeners.get("dispose")?.();
});