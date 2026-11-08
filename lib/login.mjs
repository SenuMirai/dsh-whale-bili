// 扫码登录 —— 拿 B站 的 SESSDATA，不用主人去开发者工具里挖。
//
// 为什么需要：SESSDATA 是 HttpOnly，`document.cookie` 根本读不到；
// 手填得开 F12 翻请求头，对主人来说太麻烦。二维码是官方给的路径。
//
// 两个函数都**不在模块顶层**做任何事：不读文件、不发请求、不探测解释器。
// 这样 UI 只要 import 就不会触发网络；测试也能把 fetch / findPython 整个换掉。
//
// 失败口径：
//   · 网络 / 远端返回异常 → 返回 { ok:false, ... }，让页面能显示原因；
//   · 只有调用方写错（没给 key、没有 fetch）才 throw，并且带大写蛇形 code；
//   · 画二维码失败**不算错** —— 没有 Python 或 qrcode 包时，URL 仍然能手动打开扫。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 用桌面 Chrome 的 UA，不是 Node 默认 UA：
// passport 对空 UA / 明显非浏览器的请求更容易判风控，二维码可能直接不生成。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GENERATE_URL =
  "https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header";
const POLL_URL =
  "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
// 部分响应不带 buvid3，用官方指纹接口补一个；拿不到也不影响登录，所以失败只算空。
const SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi";

// box_size=8 / border=2 → 约 400px。默认 1px 模块在手机上放大后糊成一片，扫不出来。
const QR_PY =
  "import sys, qrcode; qr=qrcode.QRCode(box_size=8, border=2); qr.add_data(sys.argv[1]); qr.make(); qr.make_image().save(sys.argv[2])";

/** 二维码落盘文件名；目录由调用方决定（通常放在插件自己的数据目录下）。 */
export const QR_FILE_NAME = "qrcode_login.png";

/** 统一成项目要求的可判别错误：throw Object.assign(new Error(msg), { code }) */
function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function shortError(e) {
  return String(e?.message ?? e).slice(0, 200);
}

function resolveFetch(fetchImpl) {
  const f = fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function") {
    throw coded("FETCH_UNAVAILABLE", "没有可用的 fetch 实现；请注入 fetch");
  }
  return f;
}

/**
 * 默认的 Python 查找器。
 *
 * 主逻辑不认路径，只用注入进来的 findPython()；这里只是给"没注入"的调用方一个合理默认。
 * 没有 dshHome 入参，所以优先读 DSH_HOME 环境变量，再退回 ~/.dsh。
 * 找不到就返回 "python" 交给 PATH；真画不出来会在 drawQr 里被当成 img:null，不是错误。
 */
function defaultFindPython() {
  let home = process.env.DSH_HOME;
  if (!home) {
    try {
      home = join(homedir(), ".dsh");
    } catch {
      home = "";
    }
  }

  const candidates = [];
  if (home) {
    candidates.push(
      join(home, "bili-whale", ".venv", "Scripts", "python.exe"),
      join(home, "bili-whale", ".venv", "bin", "python"),
      join(home, "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "python.exe"),
      join(home, "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "bin", "python3"),
    );
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // existsSync 在奇怪权限下也可能抛；换下一个候选。
    }
  }
  return "python";
}

/**
 * 从 Set-Cookie 头里解出四个凭据。
 *
 * 只取每条 cookie 的分号前第一段：Path/Domain/HttpOnly/Expires 都不是值的一部分。
 * 值**不做 URL 解码** —— SESSDATA 本身就是百分号编码的，解码后反而对不上。
 */
function credFromCookies(setCookies) {
  const cred = { sessdata: "", bili_jct: "", buvid3: "", dedeuserid: "" };
  const wanted = {
    SESSDATA: "sessdata",
    bili_jct: "bili_jct",
    DedeUserID: "dedeuserid",
    buvid3: "buvid3",
  };

  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    const first = String(raw ?? "").split(";")[0] ?? "";
    const eq = first.indexOf("=");
    // 没有等号 / 名字为空的行直接跳过，不要猜。
    if (eq <= 0) continue;

    const name = first.slice(0, eq).trim();
    const target = wanted[name];
    if (!target) continue;

    let value = first.slice(eq + 1).trim();
    // 少数客户端会加引号；B站 当前不加，但去掉不会破坏正常值。
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    cred[target] = value;
  }
  return cred;
}

/**
 * 补 buvid3：拿不到就返回空字符串。
 * 这个请求失败不能阻断登录 —— SESSDATA 才是必需的，buvid3 只是部分接口的风控辅助。
 */
async function fetchBuvid3(f) {
  try {
    const r = await f(SPI_URL, { headers: { "user-agent": UA } });
    if (r?.ok === false) return "";
    const body = await r.json();
    return String(body?.data?.b_3 ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * 画二维码并读成 data URL。
 *
 * 为什么回 base64 而不是文件路径：页面里的 <img> 打不开 file://（浏览器安全限制），
 * 只回路径时主人看到的是一行文字，像是"二维码没显示"。
 * 画失败返回 null，由调用方继续给 URL —— Python/qrcode 不是这个功能的硬依赖。
 */
async function drawQr({ filePath, url, findPython }) {
  if (!filePath) return null; // 没给落盘路径就不画；url 仍然能手动扫。

  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch {
    return null;
  }

  let python = "python";
  try {
    const found = await findPython();
    if (typeof found === "string" && found.trim()) python = found.trim();
  } catch {
    return null;
  }

  const drawn = await new Promise((resolve) => {
    try {
      execFile(
        python,
        ["-c", QR_PY, url, filePath],
        // 20 秒：卡住的 Python 不能把登录接口一起拖死；windowsHide 防止弹黑框。
        { timeout: 20_000, windowsHide: true },
        (err) => resolve(!err),
      );
    } catch {
      // execFile 在参数非法等极少数情况下会同步抛；按画失败处理。
      resolve(false);
    }
  });
  if (!drawn) return null;

  try {
    const b64 = (await readFile(filePath)).toString("base64");
    return "data:image/png;base64," + b64;
  } catch {
    return null;
  }
}

/**
 * 生成二维码。
 *
 * @param {{filePath?: string, fetch?: Function, findPython?: Function}} [options]
 * @returns {Promise<{ok: boolean, key?: string, url?: string, img?: string|null, error?: string}>}
 */
export async function startLogin({ filePath, fetch: fetchImpl, findPython } = {}) {
  const f = resolveFetch(fetchImpl);

  let r;
  try {
    r = await f(GENERATE_URL, { headers: { "user-agent": UA } });
  } catch (e) {
    return { ok: false, error: shortError(e) };
  }
  if (r?.ok === false) {
    return { ok: false, error: "二维码接口 HTTP " + String(r?.status ?? "?") };
  }

  let body;
  try {
    body = await r.json();
  } catch {
    return { ok: false, error: "二维码接口返回的不是 JSON" };
  }

  const key = String(body?.data?.qrcode_key ?? "").trim();
  const url = String(body?.data?.url ?? "").trim();
  if (!key || !url) {
    return {
      ok: false,
      error: String(body?.message || "返回里没有 qrcode_key/url").slice(0, 200),
    };
  }

  const finder = typeof findPython === "function" ? findPython : defaultFindPython;
  const img = await drawQr({ filePath, url, findPython: finder });

  return { ok: true, key, url, img };
}

/**
 * 轮询扫码结果。
 *
 * @param {{key: string, fetch?: Function}} options
 * @returns {Promise<{ok: boolean, state: "waiting"|"scanned"|"expired"|"ok"|"unknown", mid?: string, cred?: {sessdata: string, bili_jct: string, buvid3: string, dedeuserid: string}, error?: string}>}
 */
export async function pollLogin({ key, fetch: fetchImpl } = {}) {
  const qrcodeKey = String(key ?? "").trim();
  if (!qrcodeKey) {
    throw coded("LOGIN_KEY_REQUIRED", "轮询扫码结果需要 qrcode_key");
  }
  const f = resolveFetch(fetchImpl);

  let r;
  try {
    r = await f(
      POLL_URL +
        "?qrcode_key=" +
        encodeURIComponent(qrcodeKey) +
        "&source=main-fe-header",
      {
        headers: { "user-agent": UA },
        // ⚠️ 必须 manual：成功那一步的 Set-Cookie 只挂在**原始响应**上，
        // 让 fetch 自动跟随 redirect 就会把带凭据的响应换成一个空壳，凭据直接丢 ✗
        redirect: "manual",
      },
    );
  } catch (e) {
    return { ok: false, state: "unknown", error: shortError(e) };
  }
  if (r?.ok === false) {
    return {
      ok: false,
      state: "unknown",
      error: "扫码轮询 HTTP " + String(r?.status ?? "?"),
    };
  }

  // ⚠️ 凭证在 Set-Cookie 里，不在 body 的 data.url 里（body 的 url 是别的域的游戏票 ✗）。
  // 必须用 getSetCookie：Headers.get('set-cookie') 会把多条压成一行，
  // 而 Expires 本身含逗号，按逗号切会切坏 cookie ✗
  const setCookies = r?.headers?.getSetCookie?.() ?? [];

  let body = {};
  try {
    body = await r.json();
  } catch {
    // 过期 / 风控时可能回空体；这不等于网络错误，后面按 code 缺失处理。
  }

  const rawCode = body?.data?.code;
  const code =
    rawCode === null || rawCode === undefined ? Number.NaN : Number(rawCode);

  if (code === 0) {
    const cred = credFromCookies(setCookies);
    if (!cred.sessdata) {
      return {
        ok: false,
        state: "unknown",
        error: "登录成功但 Set-Cookie 里没有 SESSDATA",
      };
    }
    if (!cred.buvid3) {
      const buvid3 = await fetchBuvid3(f);
      if (buvid3) cred.buvid3 = buvid3;
    }
    return { ok: true, state: "ok", mid: cred.dedeuserid, cred };
  }

  if (!Number.isFinite(code)) {
    return {
      ok: false,
      state: "unknown",
      error: String(body?.message || "扫码轮询返回里没有 data.code").slice(0, 200),
    };
  }

  // 对外只回契约里的 ok/state：code 是内部判定依据，不扩散到返回形状里，
  // 调用方要展示原因时看 state 就够了（waiting/scanned/expired 的语义已经足够清楚）。
  const byCode = { 86101: "waiting", 86090: "scanned", 86038: "expired" };
  return { ok: true, state: byCode[code] ?? "unknown" };
}
