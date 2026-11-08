// 评论区：扫评论、生成分享文案、回复草稿、回复判重。
//
// 这个文件只做四件事，边界写死在这里：
//   1. 扫评论只走 network.request + /x/v2/reply —— 白名单没有这条路就抛 URL_DENIED，
//      **绝不在这里直接 fetch**。白名单是读写边界的唯一入口，绕一次就再也说不清哪些请求是允许的 ✗
//   2. 草稿写进 store 的 control 表，不另开 JSON 文件 —— 授权、额度、暂停、回复记录
//      已经都在这个账本里；再开一个文件就会出现"授权删了、草稿还在"的不一致 ✓
//   3. 判重（同一个人 30 天只回一次）是账本事实，不是模型记忆 —— 记忆可以改，账本不会忘 ✓
//   4. 分享文案的 @主人 是这条评论存在的理由 —— 超长时只能砍正文，不能把 @ 砍掉 ✓

import { randomUUID } from "node:crypto";

const API = "https://api.bilibili.com";
const COMMENT_PATH = "/x/v2/reply";
const DRAFT_KEY = "comment:drafts";
const REPLIED_PREFIX = "replied:";
const MAX_COMMENT = 1000; // 平台评论上限；在入草稿时就挡，别等平台拒
const MAX_REPLIED = 50; // control 一行装整个账号的账本，判重不需要无限历史
const VIA = "（via 助手）";
const DAY_MS = 86_400_000;
const MID_PATTERN = /^[1-9][0-9]{0,19}$/;

/**
 * 抛带 code 的错误。
 *
 * 为什么不用 lib/errors.mjs 的 Fault：这个文件要被 index/service 单独接线，
 * 错误码保持"看得见的普通对象"更简单；上层如果只认 Fault，接一层转换即可。
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

function readStrings(store, key) {
  const raw = store.getControl(key);
  if (!Array.isArray(raw)) return [];
  // 手工改过账本 / 旧版本写入格式不同 → 只认能解析成时间的 ISO 串，
  // 别让一条脏数据把整次判重炸掉（但也绝不把它当成"没回过"之外的东西）
  return raw.filter(
    (value) => typeof value === "string" && Number.isFinite(Date.parse(value)),
  );
}

function truncate(text, max) {
  let head = text.slice(0, Math.max(0, max));
  // 不要把一个 emoji 的代理对切成两半：切出来是半个字符，评论里会显示成 �
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head.trimEnd();
}

/**
 * 扫一个视频的评论区，找出「值得回」的评论。
 *
 * @param {object} network 网络层（至少要有 request；digest 只用到它）
 * @param {object} options
 * @param {string} [options.bvid] 只用于报错时说明"bvid 不能当 oid 用"
 * @param {string|number} options.oid 数字 aid（评论接口 type=1 只认 aid）
 * @param {number} [options.limit=20] 一页拉多少条（ps）
 * @param {number} [options.hours=24] 只看最近多少小时内发的评论
 * @param {string|number} [options.ownerMid] 主人 mid；不传则退回 data.upper.mid（视频 UP主）
 * @returns {Promise<{items: Array<object>, total: number}>}
 *
 * 为什么是"最近 hours 小时"：digest 的用途是"谁最近找过她"，
 * 一条三周前的老热评不需要现在回；默认 24 小时和养鱼的 comment-digest 对齐。
 *
 * replied 的含义是"别再回了"：这个人 30 天内被回过（markReplied），
 * 或者这条楼层本身已经被回过（talk.mjs 的 replied:<rpid>）。
 * 40 天前回过的人可以再回，所以这里故意用窗口判断，而不是"账本里有没有记录"。
 *
 * ⚠️ 覆盖范围不是"整个评论区"：sort=2 + pn=1 拿到的是平台认为最热的一页，
 *   24 小时内可能有更新但没热起来的评论不在这页里 —— 返回的 total 是评论区总数，
 *   items 是"这一页里够新的"，两者不等是正常的，别把 items 为空当成"没人找"的铁证。
 */
export async function digest(
  network,
  { bvid = "", oid, limit = 20, hours = 24, ownerMid = null } = {},
) {
  if (!network || typeof network.request !== "function")
    fail("INVALID_NETWORK", "digest 需要带 request 的 network");

  if (!Number.isInteger(limit) || limit < 1 || limit > 49)
    fail("INVALID_LIMIT", `limit 必须是 1–49 的整数，收到 ${limit}`);
  if (!Number.isFinite(hours) || hours <= 0)
    fail("INVALID_HOURS", `hours 必须是正数，收到 ${hours}`);

  const aid = String(oid ?? "").trim();
  if (!/^[1-9][0-9]{0,15}$/.test(aid)) {
    // bvid 不能直接填进 oid：评论接口 type=1 要的是 aid（数字），
    // 拿 BV 当 oid 会得到 -404 之类的空结果。调用方得自己先换成 aid ✓
    fail(
      "INVALID_OID",
      `digest 需要数字 aid 作为 oid${bvid ? `（收到 bvid=${bvid}，它不能当 oid 用）` : ""}`,
    );
  }

  const url = new URL(API + COMMENT_PATH);
  url.search = new URLSearchParams({
    type: "1",
    oid: aid,
    pn: "1",
    ps: String(limit),
    sort: "2",
  }).toString();

  // ⚠️ 只走 network.request。
  //   /x/v2/reply 现在不在 network.mjs 的 paths 白名单里 → 这里会抛 URL_DENIED。
  //   那正是期望行为：让上层看见"这条读路径没被授权"，而不是偷偷 fetch 绕过去 ✗
  //   也**不要**在这里 catch 后返回空列表 —— 那会把"没权限/被风控"伪装成"没人评论"。
  const body = await network.request(url, "api", { method: "GET" });

  const data = body?.data;
  if (!data || typeof data !== "object")
    fail("INVALID_RESPONSE", "评论接口没有返回 data（评论区可能关闭，或接口变了）");

  const replies = Array.isArray(data.replies) ? data.replies : [];
  const since = Math.floor(Date.now() / 1000) - Math.round(hours * 3600);
  const owner = resolveOwnerMid(ownerMid, data.upper);

  const store = network.store ?? null;
  if (store && typeof store.getControl !== "function")
    fail("INVALID_STORE", "network.store 不像账本（缺 getControl）");

  const items = [];
  for (const reply of replies) {
    if (!reply || typeof reply !== "object") continue;
    const rpid = String(reply.rpid_str ?? reply.rpid ?? "").trim();
    // 没有 rpid 的条目根本没法回（草稿要靠它定位楼层）→ 跳过，而不是给个空壳
    if (!rpid) continue;

    const ctime = Number(reply.ctime);
    // ctime 缺失/非法时保留：不能因为字段缺了就把它当成"很旧"丢掉
    if (Number.isFinite(ctime) && ctime > 0 && ctime < since) continue;

    const mid = String(reply.member?.mid ?? reply.mid ?? "").trim();
    items.push({
      rpid,
      mid,
      uname: String(reply.member?.uname ?? ""),
      message: String(reply.content?.message ?? ""),
      like: Number(reply.like) || 0,
      ctime: Number.isFinite(ctime) && ctime > 0 ? ctime : 0,
      isOwner: Boolean(owner && mid === owner),
      replied: repliedMark(store, mid, rpid),
    });
  }

  const count = Number(data.page?.count);
  return {
    items,
    total: Number.isFinite(count) && count >= 0 ? count : replies.length,
  };
}

/**
 * isOwner 到底按谁判：
 *   · 传了 ownerMid → 按主人 mid 判（分享/回复场景通常要这个）
 *   · 没传 → 退回接口给的 data.upper.mid（视频 UP主）
 *
 * ⚠️ UP主 ≠ 主人。network 里没有主人的 mid（只有账号凭据和账本），
 *   所以接线上要标"主人"，必须显式传 ownerMid（例如 config.owner.mid）；
 *   不传时 isOwner 只表示"UP主自己来评论区说话了"，别拿它当主人。
 */
function resolveOwnerMid(ownerMid, upper) {
  const explicit = String(ownerMid ?? "").trim();
  if (explicit) {
    if (!MID_PATTERN.test(explicit))
      fail("INVALID_OWNER_MID", `ownerMid 必须是数字 mid，收到 ${explicit}`);
    return explicit;
  }
  const upperMid = String(upper?.mid ?? "").trim();
  return MID_PATTERN.test(upperMid) ? upperMid : "";
}

/**
 * 这条评论（或这个人）在账本里有没有回复记录。
 *
 * ⚠️ 两套 key 都要查：
 *   · replied:<mid>   —— 本文件的 markReplied / repliedRecently（30 天一人一次）
 *   · replied:<rpid>  —— 现有 talk.mjs 发评论成功后记的（它记的是被回的楼层）
 *   只查 mid 的话，她刚回过的楼在 digest 里会显示"没回过"，很容易再回一遍 ✗
 */
function repliedMark(store, mid, rpid) {
  if (!store || typeof store.getControl !== "function") return false;
  if (MID_PATTERN.test(mid) && repliedRecently(store, mid)) return true;
  if (!rpid) return false;
  // 楼层记录不设 30 天窗口：它回答的是"这条评论回过没有"，不是"这个人最近回没回"
  return readStrings(store, REPLIED_PREFIX + rpid).length > 0;
}

/**
 * 分享型评论的正文：结尾 @主人，并标上"via 助手"。
 *
 * @param {object} options
 * @param {string} [options.body] 她想说的话
 * @param {string} options.ownerName 主人的昵称（不要带 @，带了也会被去掉）
 * @param {number} [options.maxLen=900] 最终上限（平台 1000，留点余量）
 * @returns {string}
 *
 * 几个刻意的取舍：
 *   · 空白折叠成单个空格 —— 分享是一条评论，不是文章；多空格/换行在评论区显示不可控，
 *     而且折叠后长度才可预期（maxLen 按 JS 字符数算）。
 *   · 正文里已经 @ 过主人 → **整段尾巴都不再追加**。一条评论 @ 两次看起来像刷屏；
 *     只补 "（via 助手）" 又会变成半截括号，反而像漏写了什么。
 *   · 超长 → 砍正文，绝不砍 @ 和 via：@主人 是分享型评论存在的理由 ✓
 */
export function shareText({ body = "", ownerName, maxLen = 900 } = {}) {
  if (!Number.isFinite(maxLen) || maxLen < 1)
    fail("INVALID_MAX_LEN", `maxLen 必须是正数，收到 ${maxLen}`);

  const name = String(ownerName ?? "")
    .replace(/^@/, "") // 调用方可能顺手把 @ 也传进来
    .replace(/\s+/g, " ")
    .trim();
  if (!name) fail("OWNER_NAME_REQUIRED", "分享型评论必须知道要 @ 谁（ownerName 为空）");

  const mention = "@" + name;
  const suffix = mention + " " + VIA;
  // 上限比尾巴还短 = 无论怎么砍正文都装不下完整的 @ → 直接说清楚，别默默截掉 @
  if (suffix.length > maxLen)
    fail(
      "INVALID_MAX_LEN",
      `maxLen=${maxLen} 装不下分享尾巴（"${suffix}" 要 ${suffix.length} 字）`,
    );

  const text = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.includes(mention)) {
    if (text.length <= maxLen) return text;
    const cut = truncate(text, maxLen);
    if (cut.includes(mention)) return cut;
    // 超长把已有的 @ 一起切掉了 → 清掉可能残留的半个 "@某某…"，
    // 再按标准尾巴补一次。这不是"重复追加"，是把它截丢的那次补回来。
    const rest = cut.replace(/@[^\s@]*$/, "").trimEnd();
    const room = maxLen - suffix.length - 1;
    if (room <= 0) return suffix;
    const head = truncate(rest, room);
    return head ? head + " " + suffix : suffix;
  }

  const room = maxLen - suffix.length - 1; // 1 = 正文和 @ 之间的空格
  if (room <= 0) return suffix;
  const head = truncate(text, room);
  return head ? head + " " + suffix : suffix;
}

function readDrafts(store) {
  const raw = store.getControl(DRAFT_KEY);
  if (!Array.isArray(raw)) return [];
  // 只取形状对的：一条脏草稿不该让"待审列表"整个打不开
  return raw.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      typeof item.message === "string",
  );
}

/**
 * 加一条待审回复草稿。
 *
 * 草稿和授权/额度在同一个 control 表里：这样"能不能发"和"想发什么"
 * 永远是同一个账本的两个值，不会出现草稿文件还在、授权已经撤了却没人发现的情况。
 *
 * 不按 rpid 去重：调用方可能 add 后改主意、drop 再 add；重复 add 会多一条，
 * 要防重就先 draftList 自己判断。也不设条数上限 —— 草稿是要给人看的，
 * 静默丢弃比占一行账本更糟；但每加一条都会重写整个数组，别拿它当日志用。
 */
export function draftAdd(
  store,
  { bvid = "", oid, rpid, targetUname = "", message } = {},
) {
  needStore(store);

  const text = String(message ?? "").trim();
  if (!text) fail("MESSAGE_EMPTY", "草稿不能是空的");
  if (text.length > MAX_COMMENT)
    fail(
      "COMMENT_TOO_LONG",
      `评论最多 ${MAX_COMMENT} 字，这条草稿有 ${text.length} 字 —— 先砍短再进待审`,
    );

  const targetOid = String(oid ?? "").trim();
  if (!/^[1-9][0-9]{0,15}$/.test(targetOid))
    fail("INVALID_OID", `草稿需要数字 aid 作为 oid，收到 ${targetOid || "（空）"}`);
  const targetRpid = String(rpid ?? "").trim();
  if (!MID_PATTERN.test(targetRpid))
    fail("INVALID_RPID", `草稿需要被回复楼层的 rpid，收到 ${targetRpid || "（空）"}`);

  const item = {
    id: randomUUID(), // id 由这里生成：调用方手拼容易撞，也避免把时间戳当 id
    createdAt: new Date().toISOString(),
    bvid: String(bvid ?? "").trim(),
    oid: targetOid,
    rpid: targetRpid,
    targetUname: String(targetUname ?? "").replace(/\s+/g, " ").trim(),
    message: text,
  };

  const list = readDrafts(store);
  list.push(item);
  store.setControl(DRAFT_KEY, list);
  return item;
}

/** 待审草稿，按创建时间倒序（最新的一条先被看到）。 */
export function draftList(store) {
  needStore(store);
  // ISO 串长度固定，字典序就是时间序；不用 Date.parse，避免脏数据变成 NaN 把排序搅乱
  return readDrafts(store).sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}

function removeDraft(store, id) {
  needStore(store);
  const wanted = String(id ?? "").trim();
  if (!wanted) fail("INVALID_DRAFT_ID", "缺少草稿 id");
  const list = readDrafts(store);
  const index = list.findIndex((item) => item.id === wanted);
  if (index < 0) fail("DRAFT_NOT_FOUND", `没有这条草稿：${wanted}`);
  const [item] = list.splice(index, 1);
  store.setControl(DRAFT_KEY, list);
  return item;
}

/** 丢掉一条草稿（主人点了"不发" / 过期了）。 */
export function draftDrop(store, id) {
  const item = removeDraft(store, id);
  return { id: item.id, dropped: true };
}

/**
 * 取出并从队列删掉（主人点了"发"）。
 *
 * 取出即删：调用方拿到返回值后应该马上去发；如果发送失败，要自己重新 draftAdd，
 * 不要指望"删了还能找回来"—— 账本里只留待审的，不保存已发出的正文。
 */
export function draftTake(store, id) {
  return removeDraft(store, id);
}

function repliedKey(mid) {
  const value = String(mid ?? "").trim();
  if (!MID_PATTERN.test(value))
    fail("INVALID_MID", `需要数字 mid，收到 ${value || "（空）"}`);
  return REPLIED_PREFIX + value;
}

/**
 * 这个人最近 days 天内被回过吗？
 *
 * 只回答"有没有"，不顺手清理旧记录 —— 读操作不写账本，
 * 清理交给 markReplied（写的时候顺手裁到 50 条）。
 */
export function repliedRecently(store, mid, days = 30) {
  needStore(store);
  if (!Number.isFinite(days) || days <= 0)
    fail("INVALID_DAYS", `days 必须是正数，收到 ${days}`);
  const key = repliedKey(mid);
  const cutoff = Date.now() - days * DAY_MS;
  return readStrings(store, key).some((iso) => Date.parse(iso) >= cutoff);
}

/**
 * 记一笔"回过这个人"。
 *
 * 值存 ISO 时间数组、最多 50 条：判重只需要知道"最近回没回"，
 * 账本不该被一条无限增长的数组养肥（control 是一行 TEXT，读写都是整行）。
 */
export function markReplied(store, mid) {
  needStore(store);
  const key = repliedKey(mid);
  const at = new Date().toISOString();
  const times = [
    ...new Set([...readStrings(store, key), at]),
  ]
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .slice(-MAX_REPLIED);
  store.setControl(key, times);
  return { mid: key.slice(REPLIED_PREFIX.length), at, kept: times.length };
}
