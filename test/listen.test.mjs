// lib/listen.mjs 的边界测试。
//
// 这些断言对着"会踩/踩过"的地方：
//   · 额度是账本事实，不是内存里的变量 —— 重启进程还得记得今天回了多少
//   · 任何一项到顶就整天停（主人原话），不是"换个人继续回"
//   · 跨日只读也应该归零，但 resetIfNewDay 才是真正写零的那一下
//   · msgfeed 的正文在 source_content 里，title 不可靠
//   · 判重同时认 replied:<mid> 和 replied:<rpid>，格式要和 comments.mjs 兼容
//   · 只有 aid 没有 BV 时，"同一视频"还得能数 —— av<aid> 兜底
//   · network 的错误原样上抛，不伪装成"没人找她"

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import {
  listenSettings,
  quota,
  canReply,
  countReply,
  resetIfNewDay,
  poll,
  replyTarget,
} from "../lib/listen.mjs";

const DATE = "2026-10-22";
const NEXT_DATE = "2026-10-23";
const BV = "BV1xx411c7mD";
const BV2 = "BV1yy411c7mD";

/** 真 Store（临时目录），测完关闭并删掉 —— 不碰 ~/.dsh 里的真账本 */
function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "fishman-listen-"));
  const store = new Store(dir);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return store;
}

test("listenSettings：默认值全对，缺字段不报错", () => {
  const defaults = {
    enabled: false,
    intervalSec: 300,
    dailyMax: 10,
    perPersonMax: 2,
    perPersonDays: 30,
    perVideoMax: 3,
    allDay: false,
    scope: "both",
  };

  assert.deepEqual(listenSettings({}), defaults);
  assert.deepEqual(listenSettings(null), defaults);
  assert.deepEqual(listenSettings({ listen: {} }), defaults);
  // 已经是取出来的 listen 段也能直接吃（canReply 会被这样直接传 settings）
  assert.deepEqual(listenSettings(defaults), defaults);

  const partial = listenSettings({ listen: { enabled: true, dailyMax: 4 } });
  assert.equal(partial.enabled, true);
  assert.equal(partial.dailyMax, 4);
  assert.equal(partial.perPersonMax, 2, "没写的字段保留默认");
});

test("listenSettings：intervalSec 夹到 ≥60，非法值退回默认", () => {
  assert.equal(listenSettings({ listen: { intervalSec: 5 } }).intervalSec, 60);
  assert.equal(listenSettings({ listen: { intervalSec: "59" } }).intervalSec, 60);
  assert.equal(listenSettings({ listen: { intervalSec: 0 } }).intervalSec, 60);
  assert.equal(listenSettings({ listen: { intervalSec: 3600 } }).intervalSec, 3600);
  assert.equal(listenSettings({ listen: { intervalSec: "abc" } }).intervalSec, 300);
  assert.equal(listenSettings({ listen: { intervalSec: null } }).intervalSec, 300);

  // 其它额度也按文档范围夹住；写错数字不该让整晚监听起不来
  assert.equal(listenSettings({ listen: { dailyMax: 0 } }).dailyMax, 1);
  assert.equal(listenSettings({ listen: { dailyMax: 999 } }).dailyMax, 50);
  assert.equal(listenSettings({ listen: { perPersonMax: 99 } }).perPersonMax, 10);
  assert.equal(listenSettings({ listen: { perVideoMax: 0 } }).perVideoMax, 1);
  assert.equal(listenSettings({ listen: { perPersonDays: 0 } }).perPersonDays, 1);
});

test("canReply：没开监听 → LISTEN_OFF；dailyMax 到顶 → DAILY_MAX", (t) => {
  const store = tempStore(t);
  const off = listenSettings({});
  assert.deepEqual(
    canReply(store, { mid: "1001", bvid: BV }, off, DATE),
    { ok: false, reason: "LISTEN_OFF" },
  );

  const settings = listenSettings({
    listen: { enabled: true, dailyMax: 2, perPersonMax: 10, perVideoMax: 20 },
  });
  assert.deepEqual(canReply(store, { mid: "1001", bvid: BV }, settings, DATE), {
    ok: true,
  });
  countReply(store, { mid: "1001", bvid: BV, rpid: "9001" }, DATE, settings);
  assert.deepEqual(canReply(store, { mid: "1002", bvid: BV2 }, settings, DATE), {
    ok: true,
  });
  countReply(store, { mid: "1002", bvid: BV2, rpid: "9002" }, DATE, settings);
  assert.deepEqual(canReply(store, { mid: "1003", bvid: BV }, settings, DATE), {
    ok: false,
    reason: "DAILY_MAX",
  });
});

test("canReply：同一人到顶 → PERSON_MAX（整天停，换目标也不放行）", (t) => {
  const store = tempStore(t);
  const settings = listenSettings({
    listen: { enabled: true, dailyMax: 50, perPersonMax: 2, perVideoMax: 20 },
  });

  countReply(store, { mid: "1001", bvid: BV, rpid: "9001" }, DATE, settings);
  countReply(store, { mid: "1001", bvid: BV2, rpid: "9002" }, DATE, settings);

  assert.equal(quota(store, DATE, settings).perPerson["1001"], 2);
  assert.deepEqual(canReply(store, { mid: "2002", bvid: BV }, settings, DATE), {
    ok: false,
    reason: "PERSON_MAX",
  });
});

test("canReply：同一视频到顶 → VIDEO_MAX", (t) => {
  const store = tempStore(t);
  const settings = listenSettings({
    listen: { enabled: true, dailyMax: 50, perPersonMax: 10, perVideoMax: 2 },
  });

  countReply(store, { mid: "1001", bvid: BV, rpid: "9001" }, DATE, settings);
  countReply(store, { mid: "1002", bvid: BV, rpid: "9002" }, DATE, settings);

  assert.equal(quota(store, DATE, settings).perVideo[BV], 2);
  assert.deepEqual(canReply(store, { mid: "1003", bvid: BV2 }, settings, DATE), {
    ok: false,
    reason: "VIDEO_MAX",
  });
});

test("countReply：连续计数正确，quota() 能从账本读回", (t) => {
  const store = tempStore(t);
  const settings = listenSettings({
    listen: { enabled: true, dailyMax: 50, perPersonMax: 10, perVideoMax: 20 },
  });

  const first = countReply(
    store,
    { mid: "1001", bvid: BV, rpid: "9001" },
    DATE,
    settings,
  );
  assert.equal(first.replies, 1);
  assert.equal(first.perPerson["1001"], 1);
  assert.equal(first.perVideo[BV], 1);

  countReply(store, { mid: "1001", bvid: BV, rpid: "9002" }, DATE, settings);
  countReply(store, { mid: "1002", bvid: BV2, rpid: "9003" }, DATE, settings);

  const q = quota(store, DATE, settings);
  assert.equal(q.date, DATE);
  assert.equal(q.replies, 3);
  assert.deepEqual(q.perPerson, { 1001: 2, 1002: 1 });
  assert.deepEqual(q.perVideo, { [BV]: 2, [BV2]: 1 });
  assert.equal(q.exhausted, false);
  assert.equal(q.reason, null);

  // 账本字段就是约定的那四个 —— 以后加字段要同时改这里和 key 注释
  assert.deepEqual(
    Object.keys(store.getControl("listen:quota")).sort(),
    ["date", "perPerson", "perVideo", "replies"],
  );

  // replied 记录也写下来了，格式和 comments.mjs 的 markReplied 一致（ISO 数组）
  const midTimes = store.getControl("replied:1001");
  assert.ok(Array.isArray(midTimes));
  assert.ok(midTimes.length >= 1);
  assert.ok(midTimes.every((x) => Number.isFinite(Date.parse(x))));
  assert.ok(Array.isArray(store.getControl("replied:9001")));
  assert.ok(Array.isArray(store.getControl("replied:9002")));
});

test("resetIfNewDay：换日归零并解除 exhausted；只读查询不写账本", (t) => {
  const store = tempStore(t);
  const settings = listenSettings({
    listen: { enabled: true, dailyMax: 1, perPersonMax: 10, perVideoMax: 10 },
  });

  countReply(store, { mid: "1001", bvid: BV, rpid: "9001" }, DATE, settings);
  const before = quota(store, DATE, settings);
  assert.equal(before.exhausted, true);
  assert.equal(before.reason, "DAILY_MAX");
  assert.deepEqual(canReply(store, { mid: "1002", bvid: BV2 }, settings, DATE), {
    ok: false,
    reason: "DAILY_MAX",
  });

  // 只读跨日：自动当 0 看，但账本还是昨天的
  const next = quota(store, NEXT_DATE, settings);
  assert.equal(next.replies, 0);
  assert.deepEqual(next.perPerson, {});
  assert.deepEqual(next.perVideo, {});
  assert.equal(next.exhausted, false);
  assert.equal(
    store.getControl("listen:quota").date,
    DATE,
    "quota 是读操作，不该写库",
  );

  // 真正写零的那一下
  assert.equal(resetIfNewDay(store, NEXT_DATE), true);
  assert.deepEqual(store.getControl("listen:quota"), {
    date: NEXT_DATE,
    replies: 0,
    perPerson: {},
    perVideo: {},
  });
  assert.equal(quota(store, NEXT_DATE, settings).exhausted, false);
  assert.deepEqual(canReply(store, { mid: "1002", bvid: BV2 }, settings, NEXT_DATE), {
    ok: true,
  });
  assert.equal(resetIfNewDay(store, NEXT_DATE), false, "同一天再调用不再重置");
});

test("poll：假 network 返回假 msgfeed，标 isOwner / replied / bvid", async (t) => {
  const store = tempStore(t);
  store.setControl("replied:1001", [new Date().toISOString()]);

  const now = Math.floor(Date.now() / 1000);
  const replyPayload = {
    code: 0,
    data: {
      items: [
        {
          id: 11,
          user: { mid: 1001, nickname: "小明" },
          reply_time: now - 60,
          item: {
            business_id: 1,
            subject_id: 170001,
            root_id: 8000,
            source_id: 9001,
            source_content: "这个视频好看",
            title: "陈旧标题（不该被当成正文）",
            uri: "https://www.bilibili.com/video/BV1xx411c7mD?reply=9001",
          },
        },
        {
          id: 12,
          user: { mid: 28645724, nickname: "示例用户" },
          reply_time: now - 30,
          item: {
            business_id: 1,
            subject_id: 170001,
            root_id: 0,
            source_id: 9002,
            source_content: "主人来找你了",
            uri: "https://www.bilibili.com/video/av170001?reply=9002",
          },
        },
        {
          id: 13,
          user: { mid: 1003, nickname: "很久以前" },
          reply_time: now - 90_000,
          item: { subject_id: 170001, source_id: 9003, source_content: "旧评论" },
        },
        {
          id: 14,
          user: { mid: 0, nickname: "没有 mid" },
          reply_time: now - 10,
          item: { subject_id: 170001, source_id: 9004, source_content: "没 mid" },
        },
      ],
    },
  };

  const calls = [];
  const network = {
    async request(url, kind, options) {
      calls.push({ url, kind, options });
      return replyPayload;
    },
  };

  const out = await poll(store, network, {
    ownerMid: "28645724",
    selfMid: "3706937948507088",
    since: now - 3600,
    scope: "reply",
    limit: 20,
  });

  assert.equal(calls.length, 1, "scope=reply 不该请求 @ 收件箱");
  const url = calls[0].url;
  assert.equal(url.origin, "https://api.bilibili.com");
  assert.equal(url.pathname, "/x/msgfeed/reply");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    type: "1",
    pn: "1",
    ps: "20",
  });
  assert.equal(calls[0].kind, "api");
  assert.equal(calls[0].options.method, "GET");

  assert.equal(out.total, 2);
  assert.deepEqual(
    out.items.map((x) => x.rpid),
    ["9001", "9002"],
    "按 ctime 正序；since 之前的、没有 mid 的都丢掉",
  );

  const [first, owner] = out.items;
  assert.equal(first.rootId, "8000");
  assert.equal(first.oid, "170001");
  assert.equal(first.bvid, BV);
  assert.equal(first.mid, "1001");
  assert.equal(first.uname, "小明");
  assert.equal(first.message, "这个视频好看", "正文取 source_content，不取 title");
  assert.equal(first.isOwner, false);
  assert.equal(first.replied, true, "replied:<mid> 在 30 天窗口内");

  assert.equal(owner.isOwner, true);
  assert.equal(owner.replied, false);
  assert.equal(owner.rootId, "", "root_id=0 归一成空串（顶层评论）");
  assert.equal(owner.bvid, "", "av 形式的 uri 没有 BV，交给 av<oid> 兜底");
});

test("poll：scope='reply' 只认直接回复，@我的不进来", async (t) => {
  const store = tempStore(t);
  const now = Math.floor(Date.now() / 1000);

  const replyPayload = {
    code: 0,
    data: {
      items: [
        {
          id: 1,
          user: { mid: 1001, nickname: "小明" },
          reply_time: now - 60,
          item: {
            subject_id: 170001,
            root_id: 8000,
            source_id: 9001,
            source_content: "直接回你",
          },
        },
      ],
    },
  };
  const atPayload = {
    code: 0,
    data: {
      items: [
        {
          id: 2,
          user: { mid: 2002, nickname: "阿蓝" },
          at_time: now - 20,
          item: {
            subject_id: 170002,
            root_id: 0,
            source_id: 9100,
            source_content: "@你 看这个",
          },
        },
      ],
    },
  };

  const paths = [];
  const network = {
    async request(url) {
      paths.push(url.pathname);
      return url.pathname === "/x/msgfeed/at" ? atPayload : replyPayload;
    },
  };

  const onlyReply = await poll(store, network, {
    since: now - 3600,
    scope: "reply",
  });
  assert.deepEqual(paths, ["/x/msgfeed/reply"], "scope=reply 时 @ 收件箱一次都不请求");
  assert.deepEqual(onlyReply.items.map((x) => x.rpid), ["9001"]);

  const both = await poll(store, network, {
    since: now - 3600,
    scope: "both",
  });
  assert.deepEqual(paths, [
    "/x/msgfeed/reply",
    "/x/msgfeed/reply",
    "/x/msgfeed/at",
  ]);
  assert.deepEqual(
    both.items.map((x) => x.rpid),
    ["9001", "9100"],
    "both 才把 @我的并进来（默认 scope 也是 both）",
  );
});

test("replyTarget：拼不出坐标就返回 null，别硬凑", () => {
  assert.equal(replyTarget(null), null);
  assert.equal(replyTarget(undefined), null);
  assert.equal(replyTarget({}), null);
  assert.equal(
    replyTarget({ oid: "BV1xx411c7mD", rpid: "9001" }),
    null,
    "BV 不能当 oid（评论接口 type=1 要数字 aid）",
  );
  assert.equal(
    replyTarget({ oid: "170001" }),
    null,
    "没有 rpid 不知道回哪条楼",
  );
  assert.equal(replyTarget({ oid: "170001", rpid: "" }), null);

  const target = replyTarget({
    oid: "170001",
    rootId: "8000",
    rpid: "9001",
    bvid: "",
    uri: "https://www.bilibili.com/video/BV1xx411c7mD?reply=9001",
    mid: "1001",
    uname: " 小明 ",
  });
  assert.deepEqual(target, {
    oid: "170001",
    root: "8000",
    parent: "9001",
    bvid: BV,
    mid: "1001",
    uname: "小明",
  });

  // 顶层评论：root_id=0 不是"根楼层 0"，留空串让调用方不传 root
  const top = replyTarget({
    oid: "170001",
    rootId: "0",
    rpid: "9001",
    bvid: BV,
    mid: "1001",
    uname: "小明",
  });
  assert.equal(top.root, "");
  assert.equal(top.bvid, BV);
});

test("poll：network 的错误原样上抛（上层靠 code 判断暂停）", async (t) => {
  const store = tempStore(t);
  const network = {
    async request() {
      throw Object.assign(new Error("PLATFORM_PAUSED"), {
        code: "PLATFORM_PAUSED",
      });
    },
  };
  await assert.rejects(
    () => poll(store, network, {}),
    (e) => e.code === "PLATFORM_PAUSED",
  );

  const denied = {
    async request() {
      throw Object.assign(new Error("URL_DENIED"), { code: "URL_DENIED" });
    },
  };
  await assert.rejects(
    () => poll(store, denied, {}),
    (e) => e.code === "URL_DENIED",
  );
});

test("同一视频：只有 oid 时用 av<oid> 计数，不同视频不会串成一格", (t) => {
  const store = tempStore(t);
  const settings = listenSettings({
    listen: { enabled: true, dailyMax: 50, perPersonMax: 10, perVideoMax: 2 },
  });

  countReply(
    store,
    { mid: "1001", bvid: "", oid: "170001", rpid: "9001" },
    DATE,
    settings,
  );
  countReply(
    store,
    { mid: "1002", bvid: "", oid: "170001", rpid: "9002" },
    DATE,
    settings,
  );

  const q = quota(store, DATE, settings);
  assert.deepEqual(q.perVideo, { av170001: 2 });
  assert.equal(q.exhausted, true);
  assert.equal(q.reason, "VIDEO_MAX");
  assert.deepEqual(
    canReply(store, { mid: "1003", bvid: "", oid: "170002" }, settings, DATE),
    { ok: false, reason: "VIDEO_MAX" },
  );

  // 两个不同视频各一条：都不该到顶
  const other = tempStore(t);
  countReply(other, { mid: "1001", bvid: "", oid: "170001" }, DATE, settings);
  countReply(other, { mid: "1002", bvid: "", oid: "170002" }, DATE, settings);
  assert.deepEqual(quota(other, DATE, settings).perVideo, {
    av170001: 1,
    av170002: 1,
  });
  assert.equal(quota(other, DATE, settings).exhausted, false);
});
