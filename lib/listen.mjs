// lib/listen.mjs —— 「全天监听：别人找她」
//
// 这个文件只做三件事，边界写死在这里：
//   1. 读收件箱：/x/msgfeed/reply（回复我的）+ /x/msgfeed/at（@我的）。
//      只走 network.request，**绝不自己 fetch** —— 白名单没放行就抛 URL_DENIED，
//      那是"这条读路径没被授权"的诚实信号，不是"没人找她" ✗
//   2. 管额度：listen:quota 一行账本 + 三个计数器；任何一项到顶就 exhausted，
//      监听停到次日。跨日靠账本里的日期字段判定，不靠定时任务擦账本 ✓
//   3. 拼坐标：msgfeed 的字段语义没有官方文档，replyTarget 只认能证明的
//      （oid + 被回楼层的 rpid），拼不出就 null，不拿 title/uri 硬凑 ✗
//
// 它**不发评论**、不决定回什么、不起定时器 —— 那些是 service / scheduler 的事。
//
// ⚠️ 接线前提（lib/network.mjs）：paths 白名单要加
//     /x/msgfeed/reply 和 /x/msgfeed/at
//   只加 reply 也能跑 scope='reply'；scope='both' 会在 @ 那一路抛 URL_DENIED。
//   按要求原样上抛，不在这里吞 ✓
//
// ⚠️ 判重为什么不 import comments.mjs：
//   两个模块都要被单独接线，互相 import 容易形成 comments ⇄ listen 的循环依赖；
//   这里只复刻**账本格式**（replied:<id> 存 ISO 串数组、最多 50 条），
//   于是 comments.repliedRecently 和这里的 poll 能读到彼此写的记录 ✓
//
// 账本（全部走 control 表，不建表）：
//   listen:quota    { date, replies, perPerson: { mid: n }, perVideo: { bvid: n } }
//   replied:<mid>   ISO 时间数组（和 comments.mjs 的 markReplied 同一格式）
//   replied:<rpid>  ISO 时间数组（和 talk.mjs 记楼层同一格式）
//
// 时间基准：date 由调用方传（应为 clock.shDate() 的上海日期）。
//   模块内**不猜时区** —— 猜错一次，凌晨那几个小时的额度会凭空回血 ✗

const API = "https://api.bilibili.com";
const REPLY_PATH = "/x/msgfeed/reply";
const AT_PATH = "/x/msgfeed/at";
const QUOTA_KEY = "listen:quota";
const REPLIED_PREFIX = "replied:";
const DAY_MS = 86_400_000;
const DEFAULT_REPLIED_DAYS = 30;
const MAX_REPLIED = 50;
const MID_PATTERN = /^[1-9][0-9]{0,19}$/;
const ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 抛带 code 的普通 Error（safeError 认这种）。
 * 不用 Fault：本模块会被 service/scheduler 单独接线，保持错误对象的形状简单。
 */
function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function needStore(store) {
  if (
    !store ||
    typeof store.getControl !== "function" ||
    typeof store.setControl !== "function"
  )
    fail("INVALID_STORE", "需要带 getControl/setControl 的 store（账本）");
}

function needDate(date) {
  const day = String(date ?? "").trim();
  if (!DATE_PATTERN.test(day))
    fail(
      "INVALID_DATE",
      `需要 YYYY-MM-DD 的日期（用 clock.shDate() 算，别让模块猜时区），收到 ${day || "（空）"}`,
    );
  return day;
}

/**
 * 把配置里的数字夹进合法区间。
 *
 * 为什么夹而不是抛：这些值来自设置页，写错一个数字不该让整晚的监听起不来；
 * 但也不能放任（dailyMax=0 等于全天一条都不回，intervalSec=5 会被平台当刷接口 ✗）。
 * null / "" / 布尔都当成"没配" → 用默认值，别让 Number(null)=0 把额度夹到最小值。
 */
function intIn(value, fallback, min, max = Number.POSITIVE_INFINITY) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  )
    return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 只认正整数 id；空串/0/BV/字母一律返回 ""，不拿它去拼 control key */
function digits(value) {
  const s = String(value ?? "").trim();
  return ID_PATTERN.test(s) ? s : "";
}

function bvidOf(value) {
  const s = String(value ?? "").trim();
  return BVID_PATTERN.test(s) ? s : "";
}

/** 从 msgfeed 的 uri 里抠 BV；uri 常见形式是 .../video/BV1xx...?reply=… */
function bvidIn(uri) {
  const m = String(uri ?? "").match(/BV[0-9A-Za-z]{10}/);
  return m ? bvidOf(m[0]) : "";
}

/** 从 uri 里抠 aid（少数场景 subject_id 缺失，uri 会写成 /video/av170001） */
function aidIn(uri) {
  const m = String(uri ?? "").match(
    /(?:\/video\/(?:av)?|[?&]aid=)(\d{1,16})/i,
  );
  return m ? digits(m[1]) : "";
}

/**
 * 「同一视频」的账本 key。
 *
 * msgfeed 的 subject_id 是 aid（数字），uri 里通常带 BV 但不保证。
 * 只有 aid 时**不能拿空串当 key**：所有视频会挤成一格，回一个视频就吃掉全天额度 ✗；
 * 也不能不计数：同一视频的上限会静默失效 ✗。
 * aid 和 BV 指向同一个视频 → 用 av<aid> 兜底，账本里两种 key 可以并存。
 */
function videoKeyOf({ bvid, oid } = {}) {
  const bv = bvidOf(bvid);
  if (bv) return bv;
  const aid = digits(oid);
  return aid ? "av" + aid : "";
}

/**
 * 把 config.listen 规整成带默认值的对象。缺字段不报错。
 *
 * @param {object} config 完整配置（{listen:{…}}）或已经取出来的 listen 段
 * @returns {{enabled:boolean,intervalSec:number,dailyMax:number,perPersonMax:number,perPersonDays:number,perVideoMax:number,allDay:boolean,scope:'reply'|'both'}}
 *
 * 几处刻意 fail-closed：
 *   · enabled 只认真正的 true —— 字符串 "true"/1 不算，宁可不监听，也别因为设置页
 *     存错类型就半夜自己开始回陌生人 ✗
 *   · scope 只认 'reply'，其余（含拼错）都当 'both'，跟 index.js 的默认值一致
 */
export function listenSettings(config) {
  const source =
    config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const raw =
    source.listen &&
    typeof source.listen === "object" &&
    !Array.isArray(source.listen)
      ? source.listen
      : source;

  return {
    enabled: raw.enabled === true,
    // 最小 60 秒：再密就像在刷接口，平台风控不区分"监听"和"刷屏"
    intervalSec: intIn(raw.intervalSec, 300, 60),
    dailyMax: intIn(raw.dailyMax, 10, 1, 50),
    perPersonMax: intIn(raw.perPersonMax, 2, 1, 10),
    // 观察窗口：判重时"这个人多久内被回过算回过了"。和 comments.mjs 的 30 天对齐
    perPersonDays: intIn(raw.perPersonDays, 30, 1, 365),
    perVideoMax: intIn(raw.perVideoMax, 3, 1, 20),
    // 默认尊重生物钟；要整夜守着才打开。反过来默认 true 会绕过作息 ✗
    allDay: raw.allDay === true,
    scope:
      String(raw.scope ?? "").trim().toLowerCase() === "reply"
        ? "reply"
        : "both",
  };
}

/**
 * 读 control；只有存的 JSON 坏掉时 getControl 才会抛。
 *
 * 账本坏了 = 状态未知。当成"今天 0 条"会静默放开额度，所以宁可报错让上层停手 ✓
 * （和养鱼 quota.mjs 的 fail-closed 同一个理由）
 */
function readControl(store, key) {
  try {
    return store.getControl(key);
  } catch {
    fail(
      "LEDGER_INVALID",
      `账本 ${key} 读不出来（control 值不是合法 JSON）—— 状态未知，先检查账本再回`,
    );
  }
}

function emptyQuota(date) {
  return { date, replies: 0, perPerson: {}, perVideo: {} };
}

function countOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function countsOf(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, count] of Object.entries(value)) {
    const n = countOf(count);
    // 手工改坏/旧格式的计数直接忽略：一个脏 key 不该让整天的额度算错
    if (!key || n <= 0) continue;
    out[String(key)] = n;
  }
  return out;
}

/**
 * 读今天的账本；日期不是今天 → 全部当 0 看。
 *
 * ⚠️ 这里**不写账本**：quota 可能被每隔几秒调一次（状态页/调度），
 *   读操作写库会让"跨日归零"变成每次读都写一次。
 */
function readToday(store, date) {
  const raw = readControl(store, QUOTA_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return emptyQuota(date);
  if (String(raw.date ?? "") !== date) return emptyQuota(date);
  return {
    date,
    replies: countOf(raw.replies),
    perPerson: countsOf(raw.perPerson),
    perVideo: countsOf(raw.perVideo),
  };
}

/**
 * 今天的额度状态（读账本；跨日自动归零）。
 *
 * @param {object} store 账本
 * @param {string} date YYYY-MM-DD（上海日期，由调用方算）
 * @param {object} [settings] listenSettings() 的结果；不传按默认额度算
 * @returns {{date:string,replies:number,perPerson:Object<string,number>,perVideo:Object<string,number>,exhausted:boolean,reason:string|null}}
 *
 * 判定顺序 daily → person → video：daily 是"全天总闸"，先报它最有用。
 * 「任何一项到顶」都算 exhausted（主人原话：到上限 → 监听停止，次日刷新）。
 *
 * ⚠️ 不传 settings 时按默认额度（10/2/3）算。默认值就是"没配"时的真实上限，
 *   但**自定义过额度就一定要把 settings 传进来**，否则状态页会报一个不准的 exhausted。
 */
export function quota(store, date, settings = null) {
  needStore(store);
  const day = needDate(date);
  const state = readToday(store, day);
  const limits = listenSettings(settings ?? {});

  let reason = null;
  if (state.replies >= limits.dailyMax) reason = "DAILY_MAX";
  else if (
    Object.values(state.perPerson).some((n) => n >= limits.perPersonMax)
  )
    reason = "PERSON_MAX";
  else if (Object.values(state.perVideo).some((n) => n >= limits.perVideoMax))
    reason = "VIDEO_MAX";

  return { ...state, exhausted: reason !== null, reason };
}

/**
 * 能不能再回一条。纯判断，不写账本。
 *
 * @param {object} store 账本
 * @param {{mid?:string,bvid?:string,oid?:string}} target 要回的那条（来自 replyTarget）
 * @param {object} settings listenSettings() 的结果
 * @param {string} date YYYY-MM-DD
 * @returns {{ok:true}|{ok:false,reason:'DAILY_MAX'|'PERSON_MAX'|'VIDEO_MAX'|'LISTEN_OFF'|'EXHAUSTED'}}
 *
 * 为什么 target 不参与判定：主人定的是「任何一项到上限 → 监听停止」，
 * 不是「换个目标继续」。判定看的是全局账本；target 留在签名里是因为调用方天然有它。
 * 不传 settings 时 enabled 默认 false → 返回 LISTEN_OFF，绝不做"没配就放行" ✗
 */
export function canReply(store, target = {}, settings, date) {
  needStore(store);
  const day = needDate(date);
  const limits = listenSettings(settings ?? {});

  if (!limits.enabled) return { ok: false, reason: "LISTEN_OFF" };

  const state = quota(store, day, limits);
  if (!state.exhausted) return { ok: true };
  return { ok: false, reason: state.reason ?? "EXHAUSTED" };
}

function readTimes(store, key) {
  const raw = readControl(store, key);
  if (!Array.isArray(raw)) return [];
  // 只认能解析成时间的 ISO 串；一条脏数据不该把整次判重炸掉
  return raw.filter(
    (value) => typeof value === "string" && Number.isFinite(Date.parse(value)),
  );
}

/**
 * 记一笔"回过这个 id"。
 *
 * 值和 comments.mjs 的 markReplied 完全同格式（ISO 数组、最多 50 条）：
 * 两个模块不共享代码，但要能读到彼此的记录，格式就是接口 ✓
 */
function markRepliedKey(store, id, at) {
  const key = REPLIED_PREFIX + id;
  const times = [...new Set([...readTimes(store, key), at])]
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .slice(-MAX_REPLIED);
  store.setControl(key, times);
}

/**
 * 记一次回复（写账本 + 自增三个计数器）。返回新状态。
 *
 * @param {object} store 账本
 * @param {{mid?:string,bvid?:string,oid?:string,rpid?:string}} target
 * @param {string} date YYYY-MM-DD
 * @param {object} [settings] 只影响返回值的 exhausted 判定，不影响计数
 * @returns {ReturnType<typeof quota>}
 *
 * 几个边界：
 *   · 计数器只增不减。真实回了 12 条就记 12，别夹到上限 —— 状态页应该看到真相
 *   · mid/bvid/oid 缺失时只记能记的维度，**不编 key**：编一个 "unknown" 会把
 *     所有未知视频挤成一格，一个视频就吃完全天额度 ✗
 *   · 顺手写 replied:<mid> 和 replied:<rpid>，下一轮 poll 才能标"回过了"
 *   · 用 store.tx：BEGIN IMMEDIATE 串行化"读-改-写"，两个进程同时记账不会丢计数 ✓
 */
export function countReply(store, target = {}, date, settings = null) {
  needStore(store);
  const day = needDate(date);
  const mid = digits(target?.mid);
  const rpid = digits(target?.rpid);
  const video = videoKeyOf(target ?? {});
  const at = new Date().toISOString();

  if (typeof store.tx !== "function")
    fail("INVALID_STORE", "countReply 需要带 tx 的 store（读-改-写要串行化）");

  store.tx(() => {
    const state = readToday(store, day);
    state.replies += 1;
    if (mid) state.perPerson[mid] = (state.perPerson[mid] ?? 0) + 1;
    if (video) state.perVideo[video] = (state.perVideo[video] ?? 0) + 1;
    store.setControl(QUOTA_KEY, state);
    if (mid) markRepliedKey(store, mid, at);
    if (rpid) markRepliedKey(store, rpid, at);
  });

  return quota(store, day, settings ?? {});
}

/**
 * 跨日归零：date 变了就清空计数、解除 exhausted。返回是否真的重置了。
 *
 * 有账本但日期不同 → 写一份今天的空账本，返回 true；
 * 同一天 / 从没记过账 → false（不是错误，就是"今天本来就是 0"）。
 * 账本形状坏了（不是对象）也顺手修成空的，避免坏数据一直卡着判定。
 *
 * @returns {boolean}
 */
export function resetIfNewDay(store, date) {
  needStore(store);
  const day = needDate(date);
  return store.tx(() => {
    const raw = readControl(store, QUOTA_KEY);
    if (!raw) return false;
    if (
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      String(raw.date ?? "") === day
    )
      return false;
    store.setControl(QUOTA_KEY, emptyQuota(day));
    return true;
  });
}

/**
 * 「这个人最近 days 天内被回过吗」。
 * 只读账本，不递归调用 comments.mjs（循环依赖），但格式对齐。
 */
function repliedWithin(store, mid, days) {
  const cutoff = Date.now() - days * DAY_MS;
  return readTimes(store, REPLIED_PREFIX + mid).some(
    (iso) => Date.parse(iso) >= cutoff,
  );
}

/**
 * 这条楼层 / 这个人在账本里有没有回复记录。
 *
 * 两套 key 都要查（和 comments.mjs 的 repliedMark 同一个理由）：
 *   · replied:<mid>  —— 30 天一人一次那套（本文件/perPersonDays）
 *   · replied:<rpid> —— 具体楼层（talk.mjs 记的）；不设时间窗，
 *     它回答的是"这条评论回过没有"，不是"这个人最近回没回"
 */
function repliedMark(store, mid, rpid, days) {
  if (MID_PATTERN.test(mid) && repliedWithin(store, mid, days)) return true;
  if (rpid && readTimes(store, REPLIED_PREFIX + rpid).length > 0) return true;
  return false;
}

function normalizeSince(since) {
  const n = Number(since);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  // 不传 since 时只看最近一天：第一次启动不该把一个月前的旧 @ 全当成"刚找她" ✗
  return Math.floor(Date.now() / 1000) - 86_400;
}

/**
 * 拉一次收件箱（单页）。
 *
 * 参数固定 type=1&pn=1&ps=<limit>：URL 由代码构造，调用方改不了路径和参数。
 *
 * ⚠️ 这里**不 catch network.request 的错**：URL_DENIED / PLATFORM_PAUSED /
 *   CREDENTIAL_EXPIRED 要原样交给上层，它靠 code 决定暂停。
 *   吞掉会变成"今天没人找她"的假象 —— 那比报错危险得多 ✗
 */
async function fetchFeed(network, path, ps) {
  const url = new URL(API + path);
  url.search = new URLSearchParams({
    type: "1",
    pn: "1",
    ps: String(ps),
  }).toString();
  const body = await network.request(url, "api", { method: "GET" });
  const data = body?.data;
  if (!data || typeof data !== "object")
    fail("INVALID_RESPONSE", `msgfeed ${path} 没有返回 data（接口可能变了）`);
  return Array.isArray(data.items)
    ? data.items.filter((item) => item && typeof item === "object")
    : [];
}

function normalizeItem(store, raw, { owner, self, cutoff, days }) {
  const info =
    raw.item && typeof raw.item === "object" && !Array.isArray(raw.item)
      ? raw.item
      : {};
  const mid = String(raw.user?.mid ?? "").trim();
  // 没有合法 mid 的条目回不了，也没法记"同一人" → 当噪音丢掉
  if (!MID_PATTERN.test(mid)) return null;
  // 自己号的动作偶尔会卷进收件箱；回自己没意义，也容易触发重复判重
  if (self && mid === self) return null;

  const ctime = Number(raw.reply_time ?? 0) || Number(raw.at_time ?? 0) || 0;
  // since 是"这之后"：早于/等于 baseline 的不报；时间戳读不出来的也不报 ——
  // 无法证明它是新的，就别拿它去回一条可能几个月前的评论 ✗
  if (!Number.isFinite(ctime) || ctime <= cutoff) return null;

  const rpid = digits(info.source_id);
  return {
    rpid,
    rootId: digits(info.root_id) || "",
    oid: digits(info.subject_id) || aidIn(info.uri),
    bvid: bvidOf(info.bvid) || bvidIn(info.uri),
    mid,
    uname: String(raw.user?.nickname ?? "").trim(),
    // ⚠️ 用 source_content，不用 title：msgfeed 的 title 实测常常是同一句陈旧值
    //   （多条 item 共用一个 title），拿它当"别人说的话"会回错内容 ✗
    message: String(info.source_content ?? ""),
    ctime,
    isOwner: Boolean(owner) && mid === owner,
    replied: repliedMark(store, mid, rpid, days),
  };
}

/**
 * 拉一次「回复我的」。
 *
 * @param {object} store 账本（判重读 replied:<mid>/<rpid>）
 * @param {object} network 只需有 request(url,'api',opts)（见 lib/network.mjs）
 * @param {object} [options]
 * @param {string} [options.ownerMid] 主人 mid → isOwner
 * @param {string} [options.selfMid] 自己的 mid；收件箱里出现自己的动作就丢掉
 * @param {number} [options.since] unix 秒，只报这之后；不传 = 最近一天
 * @param {'reply'|'both'} [options.scope] reply = 只认直接回我的；both = 再加 @我的
 * @param {number} [options.limit=20] 每路拉多少条（1–50，夹住而不是抛错）
 * @param {number} [options.perPersonDays=30] 判"这个人回过了"的时间窗
 * @returns {Promise<{items:Array<{rpid:string,rootId:string,oid:string,bvid:string,mid:string,uname:string,message:string,ctime:number,isOwner:boolean,replied:boolean}>,total:number}>}
 *
 * 返回按 ctime 正序（最老的先处理），方便上层一条条回。
 * total 是**这次真正报出来的条数**：msgfeed 没有"总共多少人找过她"的聚合字段，
 * 别把 total 当成全站未读数 ✗
 *
 * scope='reply' 只请求 /x/msgfeed/reply，不请求 @ 收件箱 ——
 * "只认直接回我的"在数据源这一层就过滤掉，不靠事后猜 item.type（语义同样没文档）。
 * scope='both' 时 @ 那一路出错会原样上抛（按要求，不吞）。
 */
export async function poll(store, network, options = {}) {
  needStore(store);
  if (!network || typeof network.request !== "function")
    fail("INVALID_NETWORK", "poll 需要带 request 的 network（lib/network.mjs 的 Network）");

  const {
    ownerMid = "",
    selfMid = "",
    since = null,
    scope = "both",
    limit = 20,
    perPersonDays = DEFAULT_REPLIED_DAYS,
  } = options ?? {};

  const ps = intIn(limit, 20, 1, 50);
  const cutoff = normalizeSince(since);
  const owner = String(ownerMid ?? "").trim();
  const self = String(selfMid ?? "").trim();
  const days = intIn(perPersonDays, DEFAULT_REPLIED_DAYS, 1, 365);
  const withAt = String(scope ?? "").trim().toLowerCase() !== "reply";

  const batches = [await fetchFeed(network, REPLY_PATH, ps)];
  if (withAt) batches.push(await fetchFeed(network, AT_PATH, ps));

  // 两路可能有重叠（同一个 id 同时出现在 reply / at），按 rpid 去重；
  // 没有 rpid 的用 mid+时间+正文兜底，避免把两条不同的话吞成一条
  const seen = new Set();
  const items = [];
  for (const batch of batches) {
    for (const raw of batch) {
      const item = normalizeItem(store, raw, {
        owner,
        self,
        cutoff,
        days,
      });
      if (!item) continue;
      const key = item.rpid
        ? "r:" + item.rpid
        : "m:" + item.mid + ":" + item.ctime + ":" + item.message;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  items.sort((a, b) => a.ctime - b.ctime);
  return { items, total: items.length };
}

/**
 * 从一条 msgfeed item 拼出「回复它」需要的坐标。
 *
 * @param {object} item poll() 返回的条目
 * @returns {{oid:string,root:string,parent:string,bvid:string,mid:string,uname:string}|null}
 *
 * 只认能证明的坐标：
 *   · oid    = 视频 aid（评论接口 type=1 只认数字 aid，BV 不能填进去）
 *   · parent = 被回楼层的 rpid（msgfeed 实测：item.source_id 就是它）
 *   · root   = 楼层根 rpid；root_id=0 表示这是顶层评论，留空串让调用方不传 root
 *   · bvid   = 优先 item.bvid，其次从 uri 里抠（msgfeed 里可能只有 aid）
 * 少 oid 或 parent 就返回 null —— 拼一个空坐标让上层发失败，比 null 更难查 ✗
 */
export function replyTarget(item) {
  if (!item || typeof item !== "object") return null;
  const oid = digits(item.oid);
  const parent = digits(item.rpid);
  if (!oid || !parent) return null;
  return {
    oid,
    // root_id=0 是"顶层评论"，不是"根楼层 0"；空串让调用方不传这个参数 ✓
    root: digits(item.rootId) || "",
    parent,
    bvid: bvidOf(item.bvid) || bvidIn(item.uri),
    mid: MID_PATTERN.test(String(item.mid ?? "").trim())
      ? String(item.mid).trim()
      : "",
    uname: String(item.uname ?? "").trim(),
  };
}
