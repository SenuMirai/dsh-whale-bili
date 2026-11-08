// 候选发现链路的容错测试。
//
// 这一组测试的由来（2026-10-22 实测踩的坑）：
//   `/x/web-interface/search/type` 在这个号上即使带 WBI 签名也持续返回 HTTP 412（风控页），
//   而 412 会触发插件的持久暂停保护 —— 那保护本身是对的，
//   但"找候选"这件事**不该因为搜索不可用就整件事停摆** ✗
//
// 所以这里断言：搜索挂了，热门/排行照样能出候选。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";

function svc() {
  const dir = mkdtempSync(join(tmpdir(), "fishman-enc-"));
  const s = new Service({ dataDir: dir });
  return {
    s,
    done: () => {
      try { s.close() } catch {}
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
    },
  };
}

/** 造一个假的 fetcher：按 URL 路径返回不同东西 */
function fakeFetcher(routes) {
  return async (u) => {
    const url = typeof u === "string" ? u : String(u);
    const path = new URL(url).pathname;
    const handler = routes[path];
    const body = handler ? handler(url) : { code: 0, data: {} };
    const text = JSON.stringify(body);
    return {
      status: 200,
      headers: { get: () => String(Buffer.byteLength(text)) },
      body: (async function* () {
        yield Buffer.from(text);
      })(),
    };
  };
}

test("热门可用时，即使搜索 412 也能出候选", async () => {
  const { s, done } = svc();
  try {
    s.config.preferences = { like: ["猫咪"] };
    s.fetcher = fakeFetcher({
      "/x/web-interface/popular": () => ({
        code: 0,
        data: {
          list: [
            { bvid: "BV1111111111", title: "热门一", owner: { name: "A" }, duration: 100 },
            { bvid: "BV2222222222", title: "热门二", owner: { name: "B" }, duration: 200 },
          ],
        },
      }),
      "/x/web-interface/ranking/v2": () => ({
        code: 0,
        data: { list: [{ bvid: "BV3333333333", title: "猫咪日常", owner: { name: "C" }, duration: 60 }] },
      }),
      // 搜索：模拟 412 —— 走 network 的暂停分支
      "/x/web-interface/nav": () => ({ code: 0, data: { wbi_img: { img_url: "https://i0.hdslb.com/x.png", sub_url: "https://i0.hdslb.com/y.png" } } }),
      "/x/web-interface/search/type": () => {
        throw Object.assign(new Error("412"), { code: "PLATFORM_PAUSED" });
      },
    });
    // 用真实网络层会把 412 变成暂停；这里直接让 fetcher 抛，走 catch 分支
    const r = await s.candidates(5);
    const list = r.result.candidates;
    assert.ok(list.length >= 2, `应该至少有热门候选，实际 ${list.length}`);
    const ids = list.map((x) => x.bvid);
    assert.ok(ids.includes("BV1111111111"));
    assert.ok(ids.includes("BV3333333333"));
  } finally { done() }
});

test("排行榜里撞上偏好的会被标上 preferenceHit，且排到前面", async () => {
  const { s, done } = svc();
  try {
    s.config.preferences = { like: ["猫咪"] };
    s.fetcher = fakeFetcher({
      "/x/web-interface/popular": () => ({ code: 0, data: { list: [] } }),
      "/x/web-interface/ranking/v2": () => ({
        code: 0,
        data: {
          list: [
            { bvid: "BV9999999999", title: "无关内容", owner: { name: "X" }, duration: 500 },
            { bvid: "BV8888888888", title: "猫咪的一天", owner: { name: "Y" }, duration: 300 },
          ],
        },
      }),
      "/x/web-interface/nav": () => ({ code: 0, data: { wbi_img: { img_url: "https://i0.hdslb.com/x.png", sub_url: "https://i0.hdslb.com/y.png" } } }),
    });
    const r = await s.candidates(5);
    const list = r.result.candidates;
    const hit = list.find((x) => x.bvid === "BV8888888888");
    assert.ok(hit, "撞上偏好的那条应该在候选里");
    assert.equal(hit.preferenceHit, "猫咪");
    assert.match(hit.why, /撞上你喜欢的/);
    // 偏好命中的排在前面
    assert.equal(list[0].bvid, "BV8888888888");
  } finally { done() }
});

test("已看过的 BV 不会再出现在候选里", async () => {
  const { s, done } = svc();
  try {
    s.fetcher = fakeFetcher({
      "/x/web-interface/popular": () => ({
        code: 0,
        data: { list: [{ bvid: "BV7777777777", title: "看过", owner: { name: "A" }, duration: 10 }] },
      }),
      "/x/web-interface/ranking/v2": () => ({ code: 0, data: { list: [] } }),
    });
    // 先存一条 reading，让 seen 里有它
    s.store.saveReading({
      bvid: "BV7777777777",
      page: 1,
      cid: 1,
      title: "看过",
      author: "A",
      url: "https://www.bilibili.com/video/BV7777777777/",
      duration: 10,
      route: "A1",
      segments: [],
      coverage: { state: "no_subtitles" },
    });
    const r = await s.candidates(5);
    assert.equal(
      r.result.candidates.some((x) => x.bvid === "BV7777777777"),
      false,
      "看过的必须被排除",
    );
  } finally { done() }
});

test("全空时明确说「这不是失败」", async () => {
  const { s, done } = svc();
  try {
    s.fetcher = fakeFetcher({
      "/x/web-interface/popular": () => ({ code: 0, data: { list: [] } }),
      "/x/web-interface/ranking/v2": () => ({ code: 0, data: { list: [] } }),
    });
    const r = await s.candidates(5);
    assert.deepEqual(r.result.candidates, []);
    assert.ok(r.result.mayBeNothing);
    assert.match(r.result.mayBeNothing, /不是失败/);
  } finally { done() }
});
