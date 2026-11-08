// 客户端拉的每一条接口，服务端都必须真的有对应路由。
//
// 踩过的坑（2026-11-08）：设置页里「她最近做了什么」那一块一直在拉 /activity，
// 右上角「测试」按钮一直在 POST /selftest —— 可服务端从来没挂过这两条路由。
// 表现就是「读活动失败：404」和「测试失败：404」，用户看到的是「设置界面不显示」。
// 这个测试把「客户端调用」和「服务端路由」对起来，缺一条就红 ✓
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const client = readFileSync(join(root, "lib", "client.js"), "utf8");
const server = readFileSync(join(root, "index.js"), "utf8");

/** 客户端侧：把 get("/x") / post("/x") 这类相对路径抠出来 */
function clientPaths() {
  const out = new Set();
  for (const m of client.matchAll(/\b(?:get|post)\(\s*["`]\/([A-Za-z0-9/_-]+)/g)) {
    // 以 / 结尾的是拼接前缀（"/pending/" + id + "/approve"），不是一条独立接口
    if (m[1].endsWith("/")) continue;
    out.add("/" + m[1]);
  }
  return out;
}

/** 服务端侧：route("/bili-fishman/api/…") */
function serverPaths() {
  const out = new Set();
  for (const m of server.matchAll(/route\(\s*"(\/bili-fishman\/api\/[^"]+)"/g)) {
    out.add(m[1].replace("/bili-fishman/api", ""));
  }
  return out;
}

test("设置页调的每条接口，服务端都有路由（少一条就是一块地方永远报错）", () => {
  const want = clientPaths();
  const have = serverPaths();
  // 自检也要能列出：确认这两条真的在（今天是补上的）
  assert.ok(want.size >= 8, "没从 client.js 抠到接口路径，正则坏了？");
  const missing = [...want].filter((p) => !have.has(p)).sort();
  assert.deepEqual(
    missing,
    [],
    "客户端在调这些接口，但服务端没挂路由：" + missing.join(", "),
  );
});

test("以前缺的那两条路由现在真的在", () => {
  const have = serverPaths();
  assert.ok(have.has("/activity"), "/activity 又没了 —— 设置页会显示「读活动失败」");
  assert.ok(have.has("/selftest"), "/selftest 又没了 —— 「测试」按钮会显示「测试失败」");
});
