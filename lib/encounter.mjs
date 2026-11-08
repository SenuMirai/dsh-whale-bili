// 遇见（encounter）—— 新插件最核心的差异所在。
//
// 为什么要有它：养鱼那边是「feed 选题 → 必须挑出 5 条 → 深读 2-3 条 → 打分 → 分享」，
// 每一步都有产出压力。它坏掉的那四天，她写的是「今天什么都没看成」——
// 那不是她的问题，是**流程逼她必须产出** ✗
//
// humanism 那边反过来：允许「没有推荐、没有新发现」，但**没有"过日子"的骨架** ——
// 它不会自己醒来，不会记得昨天看过什么，也不会想着跟主人说话。
//
// 这个文件合起来：**有骨架，但不逼产出**。
//   · 从偏好捞候选（像 feed），但**允许一条都不选**
//   · 选中的叫"遇见"，不叫"今天必须看的东西"
//   · 每条遇见都要带上"为什么选了它"和"这次可能什么都得不到"的自觉
//   · 看过什么会被记住（不重复），但**不统计"今天看了几条"**
//
// 数据来源优先级：配置的 preferences（主）→ 日记里的「爱看」行（兜底，兼容老数据）

import { need } from "./errors.mjs";
import { sign } from "./reader.mjs";

const API = "https://api.bilibili.com";
const url = (path, params) => API + path + "?" + new URLSearchParams(params);

/**
 * 取一次 WBI 签名材料。
 *
 * ⚠️ 2026-10-22 实测踩的坑：`/x/web-interface/search/type` **必须带 WBI 签名**，
 *   不带签名的请求一律返回 **HTTP 412**（风控页），而不是 code != 0。
 *   养鱼的 feed.mjs 做了签名，所以它能跑；我第一版漏了，直接 412 ✗
 *   412 会触发插件的持久暂停保护（那是对的），所以这个签名不是可选项 ✓
 */
async function wbi(network) {
  const j = await network.get(url("/x/web-interface/nav", {}));
  const wi = j?.data?.wbi_img;
  need(wi?.img_url && wi?.sub_url, "WBI_UNAVAILABLE");
  return { img: wi.img_url, sub: wi.sub_url };
}

/** 从文字里抠出偏好关键词（"·" / "、" / "," 分隔） */
export function parsePreferences(line) {
  return String(line || "")
    .split(/[·、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 候选池：搜索 + 热门，去重、去已看过。
 *
 * 与养鱼 feed 的差别：
 *   · 养鱼按「弹幕密度 + 播放量」排序 → 那是"什么最容易有反应" ✗
 *   · 这里按**偏好命中**排序，播放量只作为极弱的次序，避免把"流量"当成"值得看" ✓
 *   · 明确返回 `mayBeNothing`：捞不到候选是**正常结果**，不是失败 ✓
 */
export async function pool(network, { keywords = [], seen = new Set(), limit = 12 } = {}) {
  need(Array.isArray(keywords), "INVALID_KEYWORDS");
  need(Number.isInteger(limit) && limit >= 1 && limit <= 40, "INVALID_LIMIT");

  const rows = new Map();
  const add = (r) => {
    if (!r?.bvid || seen.has(r.bvid) || rows.has(r.bvid)) return;
    rows.set(r.bvid, r);
  };

  // ① 热门：今天世界在热闹什么（不需要签名，稳定）
  try {
    network.budget.spend("candidates");
    const j = await network.get(
      url("/x/web-interface/popular", { pn: 1, ps: Math.min(20, limit) }),
    );
    for (const it of (j?.data?.list ?? []).slice(0, limit)) {
      add({
        bvid: it.bvid,
        title: String(it.title ?? ""),
        author: it.owner?.name ?? "",
        duration: Number(it.duration ?? 0),
        url: `https://www.bilibili.com/video/${it.bvid}/`,
        why: "热门：今天很多人在看",
        preferenceHit: null,
      });
    }
  } catch (e) {
    if (e?.code === "PLATFORM_PAUSED") throw e;
  }

  // ② 排行榜：不同分区各取一点，避免全是同一个口味
  try {
    network.budget.spend("candidates");
    const j = await network.get(
      url("/x/web-interface/ranking/v2", { rid: 0, type: "all" }),
    );
    const all = (j?.data?.list ?? []).slice(0, 30);
    // 用偏好做**弱标注**（有命中就标上，没有也不影响它进候选）
    for (const it of all) {
      const title = String(it.title ?? "");
      const hit = keywords.find((k) => k && title.includes(k)) ?? null;
      add({
        bvid: it.bvid,
        title,
        author: it.owner?.name ?? "",
        duration: Number(it.duration ?? 0),
        url: `https://www.bilibili.com/video/${it.bvid}/`,
        why: hit ? `排行榜 · 撞上你喜欢的「${hit}」` : "排行榜：最近被推得很高的",
        preferenceHit: hit,
      });
    }
  } catch (e) {
    if (e?.code === "PLATFORM_PAUSED") throw e;
  }

  // ③ 搜索：**可选**，且失败完全不影响
  //
  // ⚠️ 2026-10-22 实测：`/x/web-interface/search/type` 在这个号上**即使带 WBI 签名**
  //   也持续返回 HTTP 412（风控页）。412 会触发插件的持久暂停保护（那是对的），
  //   但"找候选"这件事不该因为搜索不可用就整件事停摆 ✗
  //   → 搜索降级为"锦上添花"：只在热门/排行都没捞够时才试，且**任何失败都静默跳过** ✓
  if (rows.size < limit && keywords.length) {
    let key = null;
    try {
      key = await wbi(network);
    } catch {
      key = null;
    }
    if (key) {
      for (const kw of keywords.slice(0, 2)) {
        try {
          network.budget.spend("candidates");
          const params = sign(
            { search_type: "video", keyword: kw, order: "totalrank", page: 1 },
            key.img,
            key.sub,
          );
          const j = await network.get(url("/x/web-interface/search/type", params));
          for (const it of (j?.data?.result ?? []).slice(0, 6)) {
            add({
              bvid: it.bvid,
              title: String(it.title ?? "").replace(/<[^>]+>/g, ""),
              author: it.author ?? "",
              duration: Number(it.duration ?? 0),
              url: `https://www.bilibili.com/video/${it.bvid}/`,
              why: `搜到的：${kw}`,
              preferenceHit: kw,
            });
          }
        } catch {
          // 搜索不可用（412/风控/接口变动）→ 静默跳过，不暂停、不报错 ✓
          // 注意：这里**故意不 rethrow**，因为找候选不该被搜索拖死
        }
      }
    }
  }

  const list = [...rows.values()].slice(0, limit);
  return {
    candidates: list,
    // ⭐ 这个字段是整件事的态度：捞不到 = 今天可以什么都不看，不是失败
    mayBeNothing:
      list.length === 0
        ? "今天没有捞到候选。这不是失败 —— 可以什么都不看。"
        : null,
    note: "候选只是材料，不是任务。选几条、选不选，都由你。",
  };
}

/**
 * 把候选排成「可以怎么开始」—— 不排序成"必看榜"，只给轻的线索。
 *
 * 刻意不做的事：
 *   · 不按播放量排序（流量 ≠ 值得）
 *   · 不按弹幕密度排序（热闹 ≠ 有内容）
 *   · 不计算"今天应该看几条"
 */
export function suggest(list) {
  const short = (x) => Number(x.duration) > 0 && Number(x.duration) <= 600;
  return [...list].sort((a, b) => {
    // 偏好命中的优先，其次短一点（更容易真的看完），最后才是随机性
    const pa = a.preferenceHit ? 1 : 0;
    const pb = b.preferenceHit ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const sa = short(a) ? 1 : 0;
    const sb = short(b) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return String(a.bvid).localeCompare(String(b.bvid));
  });
}
