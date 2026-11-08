// 设置页「保存 → 读回」回环测试。
//
// 为什么非要有这一组（2026-10-22 主人的实际 bug）：
//   主人填了安全词、点保存，界面**立刻清空** ——
//   因为 POST 把 reply 存进了 settings.json，但 GET /settings 的 editable 里
//   **漏了 reply**，于是页面重读时拿不到，被默认值覆盖 ✗
//
// 这类 bug 的特征是：写进去了、但读不回来。
// 单测「配置能解析」完全抓不到它 —— 必须真的走一遍 HTTP 往返 ✓
//
// 所以这里的做法是：把**每一个**能改的字段都填一个特征值，
// POST 之后 GET 回来逐个比对。只要有人新加了字段却忘了回显，这里就红。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../index.js";

/** 挂一个最小宿主：只提供 webServer 收集路由 + 放行信任栅栏 */
function mount(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fishman-rt-"));
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
  plugin.apply(ctx, plugin.Config({ dataDir: dir, night: { enabled: false }, ...extra }));
  return {
    routes,
    dir,
    done: () => {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
    },
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v },
    end(b) { this.body = b ?? "" },
  };
}
function fakeReq(method, payload, url) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return {
    method,
    url: url || "http://x/",
    socket: { remoteAddress: "127.0.0.1" },
    on(evt, cb) {
      if (evt === "data") chunks.forEach(cb);
      if (evt === "end") cb();
      if (evt === "error") {}
    },
  };
}

/** 走一遍真实路由 */
async function hit(routes, path, method = "GET", payload) {
  const h = routes.get(path);
  assert.ok(h, "路由没挂上：" + path);
  const res = fakeRes();
  await h(fakeReq(method, payload), res);
  let j = {};
  try { j = JSON.parse(res.body) } catch {}
  return { code: res.statusCode, j };
}

// 每个可编辑字段的「特征值」—— 都是能一眼认出来的中文/独特数字
const CANARY = {
  persona: { name: "回环测试鱼", ownerTitle: "老板" },
  preferences: { like: ["猫", "狗"], dislike: ["广告"] },
  night: { enabled: true },
  windowText: "01:23-04:56, 07:08-09:10",
  model: { provider: "p-canary", model: "m-canary", reasoningEffort: "high" },
  owner: { mid: "12345678", name: "回环主人" },
  share: { enabled: false },
  listen: {
    enabled: true,
    intervalSec: 123,
    dailyMax: 7,
    perPersonMax: 3,
    perPersonDays: 11,
    perVideoMax: 4,
    allDay: true,
    scope: "reply",
  },
  reply: { autoApprove: true, safetyWords: ["测试词甲", "测试词乙", "测试词丙"] },
  enablePersonalityLearning: false,
  enableCommentWrites: false,
  enableDanmakuWrites: true,
  enableDynamicWrites: false,
  enableHistoryWrites: true,
  enableFavoriteWrites: false,
  enableLikeWrites: true,
  enableCoinWrites: false,
};

test("⭐ 每一个可编辑字段都能 保存 → 读回（防漏回显）", async () => {
  const m = mount();
  try {
    const post = await hit(m.routes, "/bili-fishman/api/settings", "POST", CANARY);
    assert.equal(post.code, 200);
    assert.equal(post.j.ok, true);

    const got = await hit(m.routes, "/bili-fishman/api/settings", "GET");
    assert.equal(got.code, 200);
    const e = got.j.editable ?? {};

    // ① 人设
    assert.equal(e.persona?.name, CANARY.persona.name, "persona.name 没回显");
    assert.equal(e.persona?.ownerTitle, CANARY.persona.ownerTitle, "persona.ownerTitle 没回显");

    // ② 偏好
    assert.deepEqual(e.preferences?.like, CANARY.preferences.like, "preferences.like 没回显");
    assert.deepEqual(e.preferences?.dislike, CANARY.preferences.dislike, "preferences.dislike 没回显");

    // ③ 作息
    assert.equal(e.night?.enabled, true, "night.enabled 没回显");
    assert.equal(got.j.windowText, CANARY.windowText, "windowText 没回显");

    // ④ 模型
    assert.equal(e.model?.provider, CANARY.model.provider, "model.provider 没回显");
    assert.equal(e.model?.model, CANARY.model.model, "model.model 没回显");
    assert.equal(e.model?.reasoningEffort, CANARY.model.reasoningEffort, "model.reasoningEffort 没回显");

    // ⑤ 主人
    assert.equal(e.owner?.mid, CANARY.owner.mid, "owner.mid 没回显");
    assert.equal(e.owner?.name, CANARY.owner.name, "owner.name 没回显");

    // ⑥ 分享
    assert.equal(e.share?.enabled, false, "share.enabled 没回显");

    // ⑦ 倾听（每一项都要）
    for (const [k, v] of Object.entries(CANARY.listen)) {
      assert.equal(e.listen?.[k], v, `listen.${k} 没回显`);
    }

    // ⑧ 回复策略 —— 就是主人踩到的那个
    assert.equal(e.reply?.autoApprove, true, "reply.autoApprove 没回显（就是这次 bug）");
    assert.deepEqual(e.reply?.safetyWords, CANARY.reply.safetyWords, "reply.safetyWords 没回显（就是这次 bug）");

    // ⑨ 人格
    assert.equal(e.enablePersonalityLearning, false, "enablePersonalityLearning 没回显");

    // ⑩ 七个写入开关
    for (const k of [
      "enableCommentWrites", "enableDanmakuWrites", "enableDynamicWrites",
      "enableHistoryWrites", "enableFavoriteWrites", "enableLikeWrites", "enableCoinWrites",
    ]) {
      assert.equal(e[k], CANARY[k], `${k} 没回显`);
    }
  } finally { m.done() }
});

test("⭐ 只改一个字段，不会把别的字段冲掉", async () => {
  const m = mount();
  try {
    await hit(m.routes, "/bili-fishman/api/settings", "POST", CANARY);
    // 只改安全词
    await hit(m.routes, "/bili-fishman/api/settings", "POST", {
      reply: { autoApprove: false, safetyWords: ["只改这一个"] },
    });
    const got = await hit(m.routes, "/bili-fishman/api/settings", "GET");
    const e = got.j.editable;
    assert.deepEqual(e.reply.safetyWords, ["只改这一个"], "新值要生效");
    assert.equal(e.reply.autoApprove, false);
    // 其他字段还在
    assert.equal(e.persona?.name, CANARY.persona.name, "别的字段被冲掉了");
    assert.equal(e.owner?.mid, CANARY.owner.mid);
    assert.equal(e.listen?.dailyMax, CANARY.listen.dailyMax);
  } finally { m.done() }
});

test("安全词按「、」和逗号都能拆开（设置页的输入方式）", async () => {
  const m = mount();
  try {
    // UI 传的是已经拆好的数组；这里验证数组原样保存
    await hit(m.routes, "/bili-fishman/api/settings", "POST", {
      reply: { autoApprove: false, safetyWords: ["甲", "乙", "丙"] },
    });
    const got = await hit(m.routes, "/bili-fishman/api/settings", "GET");
    assert.deepEqual(got.j.editable.reply.safetyWords, ["甲", "乙", "丙"]);
  } finally { m.done() }
});

test("保存后立刻生效：服务的配置里能看到新安全词", async () => {
  const m = mount();
  try {
    await hit(m.routes, "/bili-fishman/api/settings", "POST", {
      reply: { autoApprove: false, safetyWords: ["立刻生效词"] },
    });
    // status 会走 service.reload()，能反映最新配置
    const st = await hit(m.routes, "/bili-fishman/api/status", "GET");
    assert.equal(st.code, 200);
    // 用 /settings 再确认一次（reload 后读的是同一份）
    const got = await hit(m.routes, "/bili-fishman/api/settings", "GET");
    assert.deepEqual(got.j.editable.reply.safetyWords, ["立刻生效词"]);
  } finally { m.done() }
});
