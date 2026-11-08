// 手工探针：把插件的两条设置路由抓出来，直接喂假 req/res 看行为。
// 不是测试文件（不跑在 node --test 里），只用来实机确认路由通了。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "fishman-routes-"));
const routes = new Map();
const ctx = {
  tools: { register: () => () => {} },
  on: () => {},
  get: (k) => (k === "connection" ? { requestRejection: () => false } : undefined),
  sessionController: undefined,
  webServer: {
    register: ({ path, handler }) => {
      routes.set(path, handler);
      return () => {};
    },
  },
};
plugin.apply(ctx, plugin.Config({ dataDir: dir, night: { enabled: false } }));

console.log("已挂路由:", [...routes.keys()].join(", "));

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b ?? ""; },
  };
}
function fakeReq(method, payload) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return {
    method,
    socket: { remoteAddress: "127.0.0.1" },
    on(evt, cb) {
      if (evt === "data") chunks.forEach(cb);
      if (evt === "end") cb();
      if (evt === "error") {}
    },
  };
}

const settings = routes.get("/bili-fishman/api/settings");
const status = routes.get("/bili-fishman/api/status");

// 1) GET settings
let res = fakeRes();
await settings(fakeReq("GET"), res);
const got = JSON.parse(res.body);
console.log("\n[GET settings] status=" + res.statusCode + " ok=" + got.ok);
console.log("  editable.night =", JSON.stringify(got.editable.night));
console.log("  windowText =", JSON.stringify(got.windowText));
console.log("  readonly.dataDir =", got.readonly.dataDir);
console.log("  settingsPath =", got.settingsPath);

// 2) POST settings — 改人设 + 开一个开关 + 改作息
res = fakeRes();
await settings(
  fakeReq("POST", {
    persona: { name: "助手", ownerTitle: "主人" },
    enableCommentWrites: true,
    windowText: "21:00-23:30",
  }),
  res,
);
const saved = JSON.parse(res.body);
console.log("\n[POST settings] status=" + res.statusCode + " ok=" + saved.ok + " applied=" + saved.applied);
console.log("  saved =", JSON.stringify(saved.saved));

// 3) 再 GET，确认改动能读回来
res = fakeRes();
await settings(fakeReq("GET"), res);
const after = JSON.parse(res.body);
console.log("\n[GET after save]");
console.log("  persona.name =", after.editable.persona.name);
console.log("  enableCommentWrites =", after.editable.enableCommentWrites);
console.log("  windowText =", JSON.stringify(after.windowText));

// 4) POST 尝试改路径 —— 必须被丢掉
res = fakeRes();
await settings(
  fakeReq("POST", { dataDir: "C:/evil", credentialPath: "C:/evil/c.json", enableCommentWrites: false }),
  res,
);
const evil = JSON.parse(res.body);
console.log("\n[POST 尝试改路径] saved 里有没有 dataDir: " + ("dataDir" in (evil.saved ?? {})));

res = fakeRes();
await settings(fakeReq("GET"), res);
const final = JSON.parse(res.body);
console.log("  重新读一次 readonly.dataDir =", final.readonly.dataDir, "(仍然是原来的)");

// 5) GET status
res = fakeRes();
await status(fakeReq("GET"), res);
const st = JSON.parse(res.body);
console.log("\n[GET status] status=" + res.statusCode + " ok=" + st.ok);
console.log("  journals =", JSON.stringify(st.journals));
console.log("  writes.comments =", st.writes?.comments);
console.log("  writes.tools =", JSON.stringify(st.writes?.tools));

rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
