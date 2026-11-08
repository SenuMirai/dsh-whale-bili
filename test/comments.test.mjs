// 评论区模块的边界测试。
//
// 这些断言都对着"会踩/踩过"的地方：
//   · 分享尾巴不能被截断 —— 截掉 @主人，这条评论就没有分享的意义了
//   · 草稿取出即删 —— 主人点"发"之后队列不能留一条幽灵草稿
//   · 判重只认时间窗口 —— 30 天外的人可以再回，账本里的旧记录不能一直挡着
//   · digest 不吞 URL_DENIED —— 没白名单不是"没人评论"，伪装成空列表比报错更危险
//   · digest 同时认 replied:<mid> 和 replied:<rpid> —— talk.mjs 记的是后者

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  digest,
  shareText,
  draftAdd,
  draftList,
  draftDrop,
  draftTake,
  repliedRecently,
  markReplied,
} from "../lib/comments.mjs";

const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** 最小账本替身：只实现本模块用到的 getControl/setControl。 */
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getControl(key) {
      return data.has(key) ? structuredClone(data.get(key)) : null;
    },
    setControl(key, value) {
      data.set(key, structuredClone(value));
    },
    raw(key) {
      return data.get(key);
    },
  };
}

test("shareText：追加 @主人；已有 @ 不重复；超长只截正文", () => {
  assert.equal(
    shareText({ body: "  这个视频好看  ", ownerName: "示例用户" }),
    "这个视频好看 @示例用户 （via 助手）",
  );

  // 正文已经 @ 过主人：整段尾巴都不追加，且提到主人的次数仍然是 1
  const dup = shareText({ body: "  @示例用户  这个视频好看  ", ownerName: "示例用户" });
  assert.equal(dup, "@示例用户 这个视频好看");
  assert.equal(dup.match(/@示例用户/g)?.length, 1);

  // 超长：砍正文，尾巴完好，长度正好 maxLen
  const maxLen = 60;
  const long = shareText({ body: "好".repeat(2000), ownerName: "示例用户", maxLen });
  assert.equal(long.length, maxLen);
  assert.ok(long.endsWith("@示例用户 （via 助手）"));
  assert.ok(long.startsWith("好"));

  // 已有的 @ 在正文末尾、又被 maxLen 切掉时，必须补回来 —— 不能静默丢掉 @
  const cutAway = shareText({
    body: "x".repeat(200) + "@示例用户",
    ownerName: "示例用户",
    maxLen: 60,
  });
  assert.equal(cutAway.length, 60);
  assert.ok(cutAway.endsWith("@示例用户 （via 助手）"));
  assert.equal(cutAway.match(/@示例用户/g).length, 1);

  // 连尾巴都装不下 → 明确失败，不截断 @
  assert.throws(
    () => shareText({ body: "x", ownerName: "示例用户", maxLen: 5 }),
    (e) => e.code === "INVALID_MAX_LEN",
  );
  // 不知道 @ 谁 → 不是分享型评论
  assert.throws(
    () => shareText({ body: "x", ownerName: "   " }),
    (e) => e.code === "OWNER_NAME_REQUIRED",
  );
});

test("草稿：add → list → take → 再 list 就没有了", () => {
  const store = fakeStore();
  const first = draftAdd(store, {
    bvid: "BV1xx411c7mD",
    oid: "170001",
    rpid: "9001",
    targetUname: " 小明 ",
    message: "  谢谢你认真看完  ",
  });
  assert.ok(first.id, "草稿必须有 id");
  assert.ok(Number.isFinite(Date.parse(first.createdAt)), "createdAt 必须是 ISO 时间");
  assert.equal(first.message, "谢谢你认真看完");
  assert.equal(first.oid, "170001");
  assert.equal(first.rpid, "9001");

  const second = draftAdd(store, {
    oid: "170001",
    rpid: "9002",
    message: "第二条",
  });

  const list = draftList(store);
  assert.equal(list.length, 2);
  // 倒序：不要求两条时间戳不同，但必须非递增
  assert.ok(list[0].createdAt >= list[1].createdAt);

  const taken = draftTake(store, first.id);
  assert.equal(taken.id, first.id);
  assert.equal(taken.message, "谢谢你认真看完");

  const remain = draftList(store);
  assert.equal(remain.length, 1);
  assert.equal(remain[0].id, second.id);
  assert.equal(remain.some((x) => x.id === first.id), false);

  // 同一个 id 再取一次 → 已经不在队列里
  assert.throws(
    () => draftTake(store, first.id),
    (e) => e.code === "DRAFT_NOT_FOUND",
  );

  // drop 只丢、不返回正文；队列同样清空
  const dropped = draftDrop(store, second.id);
  assert.deepEqual(dropped, { id: second.id, dropped: true });
  assert.deepEqual(draftList(store), []);
});

test("draftAdd：消息超过 1000 字符抛 COMMENT_TOO_LONG", () => {
  const store = fakeStore();
  assert.throws(
    () =>
      draftAdd(store, {
        oid: "170001",
        rpid: "9001",
        message: "字".repeat(1001),
      }),
    (e) => e.code === "COMMENT_TOO_LONG",
  );
  assert.equal(draftList(store).length, 0, "超长草稿不应该进队列");

  // 1000 字本身是合法边界
  const ok = draftAdd(store, {
    oid: "170001",
    rpid: "9001",
    message: "字".repeat(1000),
  });
  assert.equal(ok.message.length, 1000);
  assert.equal(draftList(store).length, 1);
});

test("repliedRecently：mark 后为 true；超过 30 天的记录不算", () => {
  const store = fakeStore();
  assert.equal(repliedRecently(store, "1001"), false);

  markReplied(store, "1001");
  assert.equal(repliedRecently(store, "1001"), true);

  // 31 天前 → 窗口外，可以再回
  store.setControl("replied:2002", [ago(31 * DAY)]);
  assert.equal(repliedRecently(store, "2002"), false);

  // 29 天前 → 还在窗口内
  store.setControl("replied:3003", [ago(29 * DAY)]);
  assert.equal(repliedRecently(store, "3003"), true);

  // 旧记录 + 新记录混在一起：只要有一条在窗口内就算回过
  store.setControl("replied:4004", [ago(40 * DAY), ago(1 * DAY)]);
  assert.equal(repliedRecently(store, "4004"), true);

  // 最多保留 50 条（60 条旧记录 + 新的一条 → 裁到 50）
  store.setControl(
    "replied:5005",
    Array.from({ length: 60 }, (_, i) => ago((i + 1) * 1000)),
  );
  const marked = markReplied(store, "5005");
  assert.equal(marked.kept, 50);
  assert.equal(store.raw("replied:5005").length, 50);

  // 没有 mid 的"判重"没有意义 → 明确失败，而不是读一个 replied: 空 key
  assert.throws(
    () => repliedRecently(store, ""),
    (e) => e.code === "INVALID_MID",
  );
});

test("digest：只走 /x/v2/reply，标 isOwner / replied，并过滤 hours 外的评论", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    code: 0,
    data: {
      page: { count: 42, num: 1, size: 20 },
      upper: { mid: 9001 },
      replies: [
        {
          rpid: 111,
          mid: 9001,
          member: { mid: "9001", uname: "UP主本人" },
          content: { message: "我是 UP" },
          like: 5,
          ctime: nowSec - 60,
        },
        {
          rpid: 222,
          mid: 5001,
          member: { mid: "5001", uname: "路人甲" },
          content: { message: "好看" },
          like: 2,
          ctime: nowSec - 3600,
        },
        {
          rpid: 333,
          mid: 6001,
          member: { mid: "6001", uname: "两天前的人" },
          content: { message: "老评论" },
          like: 0,
          ctime: nowSec - 48 * 3600,
        },
      ],
    },
  };

  // 要求里的假 network：只有 request 一个方法
  let seen;
  const network = {
    async request(url, kind, options) {
      seen = { url, kind, options };
      return payload;
    },
  };

  const result = await digest(network, { bvid: "BV1xx411c7mD", oid: "170001" });

  // 请求形状固定：路径、参数都由代码构造，模型改不了
  assert.equal(seen.url.origin, "https://api.bilibili.com");
  assert.equal(seen.url.pathname, "/x/v2/reply");
  assert.equal(seen.kind, "api");
  assert.equal(seen.options.method, "GET");
  assert.deepEqual(Object.fromEntries(seen.url.searchParams), {
    type: "1",
    oid: "170001",
    pn: "1",
    ps: "20",
    sort: "2",
  });

  assert.equal(result.total, 42, "total 是评论区总数，不是本页条数");
  assert.equal(result.items.length, 2, "48 小时前那条应被 hours=24 挡掉");

  const up = result.items.find((x) => x.rpid === "111");
  assert.equal(up.isOwner, true, "没传 ownerMid 时按 data.upper.mid 判");
  assert.equal(up.replied, false, "network 只有 request、没有账本 → 没回过");
  assert.equal(up.mid, "9001");
  assert.equal(up.uname, "UP主本人");
  assert.equal(up.message, "我是 UP");
  assert.equal(up.like, 5);
  assert.equal(up.ctime, nowSec - 60);

  // 有账本时按 mid 判重
  const withLedger = {
    request: async () => payload,
    store: fakeStore({ "replied:5001": [new Date().toISOString()] }),
  };
  const second = await digest(withLedger, { oid: "170001" });
  assert.equal(second.items.find((x) => x.rpid === "222").replied, true);
  assert.equal(second.items.find((x) => x.rpid === "111").replied, false);

  // talk.mjs 记的是 replied:<rpid>，digest 也得认（否则刚回过的楼会重复回）
  const byRpid = {
    request: async () => payload,
    store: fakeStore({ "replied:333": [new Date().toISOString()] }),
  };
  const third = await digest(byRpid, { oid: "170001", hours: 72 });
  assert.equal(third.items.find((x) => x.rpid === "333").replied, true);

  // 显式 ownerMid：主人发的评论标 owner，UP主不再算
  const owner = await digest(
    { request: async () => payload },
    { oid: "170001", ownerMid: "5001" },
  );
  assert.equal(owner.items.find((x) => x.rpid === "222").isOwner, true);
  assert.equal(owner.items.find((x) => x.rpid === "111").isOwner, false);
});

test("digest：URL_DENIED 原样抛给上层，不伪装成空列表", async () => {
  const network = {
    async request() {
      throw Object.assign(new Error("URL_DENIED"), { code: "URL_DENIED" });
    },
  };
  await assert.rejects(
    () => digest(network, { oid: "170001" }),
    (e) => e.code === "URL_DENIED",
  );

  // 平台暂停之类的错误也一样：digest 只加信息，不改写 code
  const paused = {
    async request() {
      throw Object.assign(new Error("PLATFORM_PAUSED"), {
        code: "PLATFORM_PAUSED",
      });
    },
  };
  await assert.rejects(
    () => digest(paused, { oid: "170001" }),
    (e) => e.code === "PLATFORM_PAUSED",
  );
});

test("digest：拿 bvid 当 oid 会明确失败，不会发一个注定 -404 的请求", async () => {
  let called = false;
  const network = {
    async request() {
      called = true;
      return { code: 0, data: {} };
    },
  };
  await assert.rejects(
    () => digest(network, { bvid: "BV1xx411c7mD" }),
    (e) => e.code === "INVALID_OID" && /bvid/.test(e.message),
  );
  assert.equal(called, false, "参数不成立时就不该发起请求");
});
