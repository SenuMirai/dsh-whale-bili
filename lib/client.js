/**
 * dsh-bili-fishman —— 客户端半边：DSH「设置」里的 **刷B站**
 *
 * 2026-11-08 改名 + 瘦身：
 *   原来这一页叫「鱼与人」，还管着信和日记。主人说得对：世界是记忆中心，
 *   日记世界已经有了，信也该在世界写 —— 那这一页只剩「刷 B站」这一件事，
 *   名字就直说它干什么。
 *
 *   · 信 → 世界插件（工具 write_letter，设置里单独一页「她写的信」）
 *   · 日记 / 日子 / 信笺 / 人格札记 → 全拆（世界那边写）
 *   · 刷过什么 → 活动账本 → 世界的 biliBridge 读成记忆，当日记素材
 *
 * 数据流：section ⇄ `/bili-fishman/api/*`（同源 fetch）⇄ 宿侧
 *   · 配置类改动落 `<dataDir>/settings.json`（覆盖层），**不用重启 DSH 就生效** ✓
 *   · 路径和凭据**故意不可改**（白名单在宿侧 overrides.mjs）
 */
window.__ModuleLoader__.load({
  id: "dsh-bili-fishman",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useMemo, useState } = React;

    const API = "/bili-fishman/api";
    const CSS_TAG = "dsh-bili-fishman/section.css";
    const CSS = [
      ".bfm{max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      // 吸顶工具条：保存按钮在右上角，滚到哪儿都能点 ✓
      ".bfm-bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0 9px;background:var(--dsw-alias-bg-base,#17171b);border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".bfm-bar-title{font-size:16px;font-weight:600;line-height:24px;margin:0}",
      ".bfm-bar-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".bfm-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".bfm-intro{color:var(--dsw-alias-label-tertiary);margin:6px 0 4px;font-size:13px;line-height:20px}",
      ".bfm-group{margin-top:18px;font-size:13px;font-weight:600;line-height:20px}",
      ".bfm-rows{display:flex;flex-direction:column}",
      ".bfm-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".bfm-row:last-child{border-bottom:none}",
      ".bfm-row>div:first-child{flex:1;min-width:200px}",
      ".bfm-label{font-size:13px;line-height:19px}",
      ".bfm-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}",
      ".bfm-input,.bfm-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:200px;outline:none}",
      ".bfm-select{min-width:240px}",
      ".bfm-num{width:88px;min-width:88px}",
      ".bfm-input:focus-visible,.bfm-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".bfm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:10px}",
      ".bfm-btn{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".bfm-btn:disabled{opacity:.5;cursor:default}",
      ".bfm-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".bfm-btn-sm{height:26px;padding:0 10px;font-size:12px}",
      ".bfm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;opacity:.75;word-break:break-all}",
      ".bfm-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px}",
      ".bfm-ok{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:8px}",
      ".bfm-letter{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-top:8px}",
      ".bfm-letter-head{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}",
      ".bfm-letter-body{font-size:13px;line-height:20px;white-space:pre-wrap}",
      ".bfm-tabs{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}",
      ".bfm-tab{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:999px;font-size:12px;height:26px;padding:0 12px;cursor:pointer}",
      ".bfm-tab.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}",
      ".bfm-qr{display:block;margin:8px 0;background:#fff;border-radius:8px;padding:6px}",
      // 日历分组
      ".bfm-day{margin-top:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}",
      ".bfm-day-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;cursor:pointer;background:rgba(127,127,127,.06);font-size:12.5px}",
      ".bfm-day-head:hover{background:rgba(127,127,127,.11)}",
      ".bfm-day-body{padding:2px 12px 10px}",
      ".bfm-day-count{color:var(--dsw-alias-label-tertiary);font-size:11.5px}",
      ".bfm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:8px}",
    ].join("");

    function useCss() {
      useEffect(() => {
        if (document.querySelector('style[data-dsh="' + CSS_TAG + '"]')) return;
        const el = document.createElement("style");
        el.setAttribute("data-dsh", CSS_TAG);
        el.textContent = CSS;
        document.head.appendChild(el);
      }, []);
    }

    async function call(method, path, body) {
      const r = await fetch(API + path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }
    const get = (p) => call("GET", p);
    const post = (p, b) => call("POST", p, b);

    const SWITCHES = [
      ["enableCommentWrites", "评论", "在视频下发一条评论（≤1000 字）"],
      ["enableDanmakuWrites", "直播弹幕", "在直播间发一条弹幕（≤20 字）"],
      ["enableDynamicWrites", "动态", "发一条纯文字动态（≤2000 字）"],
      ["enableHistoryWrites", "历史", "上报观看进度（需本地消费回执）"],
      ["enableFavoriteWrites", "收藏", "加入已授权的收藏夹"],
      ["enableLikeWrites", "点赞", "点赞（只能加，不能取消）"],
      ["enableCoinWrites", "投币", "投币（累计目标，不附带点赞）"],
    ];

    const list = (v) => (Array.isArray(v) ? v.join("、") : "");
    const parseList = (s) =>
      String(s || "")
        .split(/[、,，;；\n]/)
        .map((x) => x.trim())
        .filter(Boolean);

    // ── 通用小部件 ────────────────────────────────────────────────────
    const Row = (p) =>
      h(
        "div",
        { className: "bfm-row" },
        h("div", null, h("div", { className: "bfm-label" }, p.label), p.hint ? h("div", { className: "bfm-hint" }, p.hint) : null),
        p.children,
      );

    const Input = (p) =>
      h("input", {
        className: "bfm-input" + (p.num ? " bfm-num" : ""),
        style: p.width ? { width: p.width, minWidth: p.width } : undefined,
        type: p.num ? "number" : "text",
        min: p.min,
        max: p.max,
        value: p.value ?? "",
        placeholder: p.placeholder ?? "",
        onChange: (e) => p.onChange(p.num ? Number(e.target.value) : e.target.value),
      });

    const Check = (p) =>
      h("input", { type: "checkbox", checked: !!p.checked, onChange: (e) => p.onChange(e.target.checked) });

    const Select = (p) =>
      h(
        "select",
        { className: "bfm-select", value: p.value ?? "", onChange: (e) => p.onChange(e.target.value) },
        p.placeholder !== undefined ? h("option", { value: "" }, p.placeholder) : null,
        ...p.options.map((o) => h("option", { key: o.value, value: o.value }, o.label)),
      );

    /**
     * 日历分组 + 折叠。
     *
     * 主人要的是「按日历折叠筛选」：一天一个可折叠的块，能一眼看出哪天写了、哪天没写。
     * 分组在**客户端**做（服务端只给排好序的数组）—— 因为筛选是展示层的事，
     * 而且这样点开/收起不用再跑一趟网络 ✓
     */
    function Calendar({ entries, renderEntry, emptyText, defaultOpenCount = 3 }) {
      const [open, setOpen] = useState({});
      const days = useMemo(() => {
        const map = new Map();
        for (const e of entries) {
          const d = e.date || "(未知日期)";
          if (!map.has(d)) map.set(d, []);
          map.get(d).push(e);
        }
        return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
      }, [entries]);

      if (!days.length) return h("div", { className: "bfm-empty" }, emptyText);

      return h(
        "div",
        null,
        ...days.map(([date, items], i) => {
          // 默认展开最近几天，更早的收起 —— 一年的日记全铺开没法用 ✓
          const isOpen = open[date] !== undefined ? open[date] : i < defaultOpenCount;
          return h(
            "div",
            { className: "bfm-day", key: date },
            h(
              "div",
              { className: "bfm-day-head", onClick: () => setOpen({ ...open, [date]: !isOpen }) },
              h("span", null, (isOpen ? "▾ " : "▸ ") + date),
              h("span", { className: "bfm-day-count" }, items.length + " 篇"),
            ),
            isOpen ? h("div", { className: "bfm-day-body" }, ...items.map(renderEntry)) : null,
          );
        }),
      );
    }

    /** 存一份文本到本地 —— 用浏览器下载，主人自己选存哪 ✓ */
    function downloadText(filename, text) {
      try {
        const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) {
        /* 下载失败不该让页面崩 */
      }
    }

    // ── 信和日记已经搬走了（2026-11-08）────────────────────────────────
    // 主人原话：「鱼与人的信和日记都取消掉，世界那边已经有日记了，世界是记忆中心」。
    // 所以这一页不再有「她写给我的信 / 她的日记」两块：
    //   · 日记 → 世界插件（她每天在那里写，素材是这里的活动账本）
    //   · 写信 → 世界插件（工具 write_letter，设置里单独一页「她写的信」）
    // 这里只留「刷」这件事本身。


    // ── 待审回复 ──────────────────────────────────────────────────────
    function PendingBox() {
      const [items, setItems] = useState(null);
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState("");
      const load = useCallback(async () => {
        setErr("");
        try {
          const j = await get("/pending");
          setItems(j.items ?? []);
        } catch (e) { setErr(e.message) }
      }, []);
      useEffect(() => { load(); }, [load]);

      const act = async (id, what) => {
        setBusy(id + what);
        try {
          await post("/pending/" + what, { id });
          await load();
        } catch (e) { setErr(e.message) } finally { setBusy("") }
      };

      if (err) return h("div", { className: "bfm-err" }, "读待审失败：" + err);
      if (!items) return h("div", { className: "bfm-hint" }, "读取中…");
      if (!items.length)
        return h("div", { className: "bfm-hint" }, "没有待审的回复。她想回谁的时候，草稿会先出现在这里等你点头。");

      return h(
        "div",
        null,
        ...items.map((x) =>
          h("div", { className: "bfm-letter", key: x.id },
            h("div", { className: "bfm-letter-head" }, "回复 @" + (x.targetUname || "网友") + (x.bvid ? " · " + x.bvid : "")),
            h("div", { className: "bfm-letter-body" }, x.message),
            h("div", { className: "bfm-actions" },
              h("button", { className: "bfm-btn bfm-btn-sm", onClick: () => act(x.id, "approve"), disabled: !!busy },
                busy === x.id + "approve" ? "发送中…" : "发出去"),
              h("button", { className: "bfm-btn bfm-btn2 bfm-btn-sm", onClick: () => act(x.id, "reject"), disabled: !!busy }, "不发")))),
      );
    }

    // ── 模型 ──────────────────────────────────────────────────────────
    function ModelBox({ form, set }) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState("");
      const [test, setTest] = useState("");
      const [busy, setBusy] = useState("");
      const M = form.model ?? {};

      const load = useCallback(async () => {
        setErr("");
        try { setData(await get("/models")) } catch (e) { setErr(e.message) }
      }, []);
      useEffect(() => { load(); }, [load]);

      const groups = data?.groups ?? [];
      const cur = data?.current ?? null;
      const liveText =
        cur && cur.provider ? cur.provider + " / " + cur.model : "（读不到 —— 见下方提示）";

      // ⚠️ 2026-10-22 改：**取消「跟随默认」**
      //   主人说它"容易误导、模糊不清"—— 说得对：
      //   界面上写着"跟随默认"，但没人知道默认到底是哪个模型 ✗
      //   现在选择框**永远是一个具体模型**：没配过就用当前在跑的那个顶上 ✓
      const effProvider = M.provider || cur?.provider || "";
      const effModel = M.model || cur?.model || "";
      const setM = (k, v) => set("model", { ...M, [k]: v });

      const doTest = async () => {
        setBusy("test"); setTest("");
        try {
          const j = await post("/model/test", { provider: M.provider || "", model: M.model || "" });
          setTest((j.available ? "✓ " : "✗ ") + (j.message || ""));
        } catch (e) {
          setTest("✗ " + e.message);
        } finally { setBusy("") }
      };

      return h(
        "div",
        null,
        h("div", { className: "bfm-rows" },
          Row({ label: "当前实际在用", hint: "她那个会话现在真正跑的", children: h("div", { className: "bfm-mono" }, liveText) }),
          Row({
            label: "model provider",
            hint: groups.length ? "不选 = 跟随 DSH 全局默认" : "读不到目录 —— 见下方提示",
            children: h(Select, {
              value: M.provider,
              onChange: (v) => set("model", { ...M, provider: v, model: "" }),
              placeholder: "（跟随默认）",
              options: groups.map((g) => ({ value: g.provider, label: g.label + " · " + g.provider + "（" + g.models.length + " 个）" })),
            }),
          }),
          Row({
            label: "选 model",
            hint: "🆓 = 含在积分里；数字是上下文窗口",
            children: h(Select, {
              value: M.model,
              onChange: (v) => setM("model", v),
              placeholder: "（跟随默认）",
              options: (groups.find((g) => g.provider === M.provider)?.models ?? []).map((m) => ({
                value: m.id,
                label: (m.free ? "🆓 " : "") + m.name + " · " + m.id +
                  (m.contextWindow ? " · " + Math.round(m.contextWindow / 1000) + "k" : ""),
              })),
            }),
          }),
          Row({
            label: "推理强度（可空）",
            hint: "留空 = 模型默认",
            children: h(Input, { value: M.reasoningEffort, onChange: (v) => setM("reasoningEffort", v), placeholder: "例如 high / low", width: "140px" }),
          }),
        ),
        err ? h("div", { className: "bfm-err" }, "读模型失败：" + err) : null,
        !err && !groups.length
          ? h("div", { className: "bfm-hint", style: { marginTop: "6px" } },
              "没有读到模型目录。如果你装了 WorkBuddy，检查 ~/.dsh/.workbuddy-catalog.json 是否存在。")
          : null,
        h("div", { className: "bfm-actions" },
          h("button", { className: "bfm-btn bfm-btn2 bfm-btn-sm", onClick: load }, "刷新列表"),
          h("button", { className: "bfm-btn bfm-btn2 bfm-btn-sm", onClick: doTest, disabled: !!busy }, busy === "test" ? "检测中…" : "测试模型"),
          test ? h("span", { className: test.startsWith("✓") ? "bfm-ok" : "bfm-err" }, test) : null),
        h("div", { className: "bfm-hint", style: { marginTop: "6px" } },
          "改完点右上角「保存」；她下次醒来时会切过去，不用重启 DSH。"),
      );
    }

    // ── 扫码登录 ──────────────────────────────────────────────────────
    function LoginBox() {
      const [qr, setQr] = useState(null);
      const [state, setState] = useState("");
      const [msg, setMsg] = useState("");
      const [busy, setBusy] = useState("");

      const start = async () => {
        setBusy("qr"); setMsg(""); setState(""); setQr(null);
        try {
          const j = await post("/login/start", {});
          setQr(j);
          setState("waiting");
        } catch (e) {
          setMsg("出码失败：" + e.message);
        } finally { setBusy("") }
      };

      useEffect(() => {
        if (!qr?.key || (state !== "waiting" && state !== "scanned")) return;
        let alive = true;
        const id = setInterval(async () => {
          try {
            const j = await post("/login/poll", { key: qr.key });
            if (!alive) return;
            setState(j.state);
            if (j.state === "ok") { setMsg("✓ 登录成功，凭据已写入（不回显）"); clearInterval(id) }
            else if (j.state === "expired") { setMsg("二维码过期了，重新出码"); clearInterval(id) }
          } catch (e) {
            if (alive) setMsg("轮询失败：" + e.message);
          }
        }, 2000);
        return () => { alive = false; clearInterval(id) };
      }, [qr, state]);

      return h(
        "div",
        null,
        h("div", { className: "bfm-hint" },
          "SESSDATA 是 HttpOnly，F12 的 console 拿不到 —— 所以扫码是唯一靠谱的方式。",
          "登录后凭据写进本插件自己的文件（不回显、不经过页面）。"),
        h("div", { className: "bfm-actions" },
          h("button", { className: "bfm-btn bfm-btn-sm", onClick: start, disabled: !!busy },
            busy === "qr" ? "出码中…" : state === "waiting" || state === "scanned" ? "重新出码" : "出二维码")),
        qr?.img ? h("img", { className: "bfm-qr", src: qr.img, alt: "B站登录二维码", width: 180, height: 180 }) : null,
        qr && !qr.img
          ? h("div", { className: "bfm-err" },
              "二维码没画出来（缺 python qrcode 模块）。手动打开下面链接用手机扫：",
              h("div", { className: "bfm-mono" }, qr.url || ""))
          : null,
        state === "waiting" ? h("div", { className: "bfm-hint" }, "等扫码…") : null,
        state === "scanned" ? h("div", { className: "bfm-hint" }, "已扫码，等手机确认…") : null,
        msg ? h("div", { className: msg.startsWith("✓") ? "bfm-ok" : "bfm-err" }, msg) : null,
      );
    }

    // ── 她最近做了什么（活动账本）─────────────────────────────────────
    //
    // 主人原话：「我也看不到她到底看了什么视频、发了什么评论、点赞、收藏了什么」
    // 这一块就是答案：全部来自本地活动账本，不联网、点开链接能直接看到原始内容 ✓
    const ACT_LABEL = {
      read: "看了",
      comment: "评论",
      danmaku: "弹幕",
      dynamic: "动态",
      like: "点赞",
      coin: "投币",
      favorite: "收藏",
      history: "观看进度",
      listen: "有人找她",
      letter: "写信",
      journal: "信笺",
      diary: "日记",
      test: "测试",
    };

    function ActivityBox() {
      const [data, setData] = useState(null);
      const [err, setErr] = useState("");
      const [filter, setFilter] = useState("");
      const load = useCallback(async () => {
        setErr("");
        try { setData(await get("/activity?limit=60")) } catch (e) { setErr(e.message) }
      }, []);
      useEffect(() => { load(); }, [load]);

      if (err) return h("div", { className: "bfm-err" }, "读活动失败：" + err);
      if (!data) return h("div", { className: "bfm-hint" }, "读取中…");

      const items = (data.items ?? []).filter((x) => !filter || x.kind === filter);
      const kinds = Object.entries(data.summary ?? {}).filter(([, n]) => n > 0);

      return h(
        "div",
        null,
        h("div", { className: "bfm-tabs" },
          h("button", { className: "bfm-tab" + (filter === "" ? " on" : ""), onClick: () => setFilter("") },
            "全部 " + (data.items ?? []).length),
          ...kinds.map(([k, n]) =>
            h("button", { key: k, className: "bfm-tab" + (filter === k ? " on" : ""), onClick: () => setFilter(k) },
              (ACT_LABEL[k] ?? k) + " " + n))),

        h(Calendar, {
          entries: items.map((x) => ({ ...x, date: String(x.at ?? "").slice(0, 10) })),
          emptyText: "还没有活动记录。她读过东西、发过言之后，这里就会出现。",
          defaultOpenCount: 2,
          renderEntry: (x) =>
            h("div", { className: "bfm-letter", key: x.id },
              h("div", { className: "bfm-letter-head" },
                (ACT_LABEL[x.kind] ?? x.kind) +
                (x.status && x.status !== "ok" ? " · " + x.status : "") +
                (x.isTest ? " · 测试" : "") +
                " · " + String(x.at ?? "").slice(11, 16)),
              x.title ? h("div", { className: "bfm-letter-body" }, x.title) : null,
              x.detail && x.detail !== x.title
                ? h("div", { className: "bfm-hint" }, String(x.detail).slice(0, 300))
                : null,
              x.link
                ? h("div", { className: "bfm-actions", style: { marginTop: "6px", paddingTop: "0" } },
                    h("a", { className: "bfm-btn bfm-btn2 bfm-btn-sm", href: x.link, target: "_blank", rel: "noreferrer" }, "打开原视频"))
                : null),
        }),
        h("div", { className: "bfm-actions", style: { marginTop: "8px", paddingTop: "0" } },
          h("button", { className: "bfm-btn bfm-btn2 bfm-btn-sm", onClick: load }, "刷新")),
      );
    }

    // ── 倾听（全天监听「别人找她」）────────────────────────────────────
    function ListenBox({ form, set, status }) {
      const L = form.listen ?? {};
      const setL = (k, v) => set("listen", { ...L, [k]: v });
      const q = status?.listen;

      // ⚠️ 安全词用**原始文本**保存，只在保存时才拆
      //   踩过的坑：原来 onChange 里当场 split 再 join 回去，
      //   于是你敲下「、」的瞬间它就被吃掉 —— 根本打不进分隔符 ✗
      //   现在输入框里就是纯文本，想怎么打就怎么打 ✓
      const replyText = form.replyText ?? "";
      const words = parseList(replyText);

      return h(
        "div",
        null,
        h("div", { className: "bfm-hint", style: { marginBottom: "4px" } },
          "打开后她会定时去看「回复我的」。任何一项额度到顶就**停止监听、次日重置**。",
          "找到的回复仍然先进待审队列，你点头才发。"),
        h("div", { className: "bfm-rows" },
          Row({ label: "开启全天监听", hint: "关掉 = 不会主动去看谁找过她", children: h(Check, { checked: L.enabled === true, onChange: (v) => setL("enabled", v) }) }),
          Row({ label: "监听频率（秒）", hint: "最小 60；别让平台觉得在刷接口", children: h(Input, { num: true, min: 60, max: 3600, value: L.intervalSec ?? 300, onChange: (v) => setL("intervalSec", v) }) }),
          Row({ label: "全天最大回复数", hint: "到达后立即停止，次日刷新", children: h(Input, { num: true, min: 1, max: 50, value: L.dailyMax ?? 10, onChange: (v) => setL("dailyMax", v) }) }),
          Row({ label: "同一个人上限", hint: "在下面这个天数窗口内", children: h(Input, { num: true, min: 1, max: 10, value: L.perPersonMax ?? 2, onChange: (v) => setL("perPersonMax", v) }) }),
          Row({ label: "同一人观察窗口（天）", hint: "默认 30 天", children: h(Input, { num: true, min: 1, max: 365, value: L.perPersonDays ?? 30, onChange: (v) => setL("perPersonDays", v) }) }),
          Row({ label: "同一视频上限", hint: "到达后停止监听该视频，全天额度也受影响", children: h(Input, { num: true, min: 1, max: 20, value: L.perVideoMax ?? 3, onChange: (v) => setL("perVideoMax", v) }) }),
          Row({
            label: "只回什么",
            hint: "reply = 只回直接回我的；both = 也回 @我的",
            children: h(Select, {
              value: L.scope ?? "both",
              onChange: (v) => setL("scope", v),
              options: [{ value: "both", label: "直接回我的 + @我的" }, { value: "reply", label: "只回直接回我的" }],
            }),
          }),
          Row({ label: "我睡着时也守", hint: "全天守，不只在作息窗口里", children: h(Check, { checked: L.allDay === true, onChange: (v) => setL("allDay", v) }) }),
        ),

        // ── 回复别人：免审核 + 安全词（2026-10-22 主人要求）──────────────
        h("div", { className: "bfm-group" }, "回复别人：审核与安全词"),
        h("div", { className: "bfm-hint", style: { marginBottom: "4px" } },
          "默认每条回复都要你点头。打开「免审核」她就直接发 —— ",
          "但**安全词永远优先**：对方说的话或她的回复里命中任一个词，直接不回，连草稿都不进。"),
        h("div", { className: "bfm-rows" },
          Row({
            label: "免审核直接回",
            hint: "打开 = 她写好的回复直接发出去，不经过这里；关掉 = 进待审队列",
            children: h(Check, { checked: form.replyAutoApprove === true, onChange: (v) => set("replyAutoApprove", v) }),
          }),
          Row({
            label: "安全词",
            hint: "用「、」或逗号分隔。命中任一个就不回（对对方的话和她的回复都生效）",
            children: h(Input, {
              // 原始文本，不在 onChange 里拆分 —— 否则分隔符打不进去 ✓
              value: replyText,
              onChange: (v) => set("replyText", v),
              placeholder: "例如：政治、广告、代购、加微信",
            }),
          }),
          Row({
            label: "当前生效",
            hint: "保存后的实际条数",
            children: h("div", { className: "bfm-label" }, words.length ? words.length + " 个：" + words.join("、") : "未设置（任何回复都不拦）"),
          }),
        ),

        q
          ? h("div", { className: "bfm-rows", style: { marginTop: "8px" } },
              Row({ label: "今天已回", hint: "到 dailyMax 就停", children: h("div", { className: "bfm-label" }, (q.replies ?? 0) + " / " + (q.dailyMax ?? L.dailyMax ?? 10)) }),
              Row({ label: "监听状态", children: h("div", { className: "bfm-label" }, q.exhausted ? "已停止（" + (q.reason || "") + "），次日恢复" : L.enabled === true ? "监听中" : "未开启") }))
          : null,
      );
    }

    // ── 主页面 ────────────────────────────────────────────────────────
    
    /**
     * 临时诊断组件 —— 看得见就说明挂载链是通的。
     * 排查完恢复成真正的 FishmanSection。
     */
    function ProbeSection() {
      const React = require("react");
      const hh = React.createElement;
      const [n, setN] = React.useState(0);
      React.useEffect(() => { setN(1); }, []);
      return hh("div", { style: { padding: "24px", fontSize: "16px", lineHeight: "1.8" } },
        hh("div", null, "✅ 刷B站：组件挂载成功"),
        hh("div", { style: { opacity: 0.7, fontSize: "13px", marginTop: "8px" } }, "effect 跑了 " + n + " 次 · 如果你看到这段字，说明 slots 挂载链是通的，问题在 FishmanSection 内部"),
      );
    }

    function FishmanSection() {
      useCss();
      const [form, setForm] = useState(null);
      const [info, setInfo] = useState(null);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState("");
      const [err, setErr] = useState("");
      const [msg, setMsg] = useState("");
      // 自检结果：null = 没跑过；[] = 跑过（可能为空）
      const [testSteps, setTestSteps] = useState(null);
      // 自检**真的产出了什么**（日记 / 信 / 评论），主人据此核对 ✓
      const [testArtifacts, setTestArtifacts] = useState(null);

      const load = useCallback(async () => {
        setErr("");
        try {
          const j = await get("/settings");
          const e = j.editable ?? {};
          setForm({
            name: e.persona?.name ?? "",
            ownerTitle: e.persona?.ownerTitle ?? "主人",
            like: list(e.preferences?.like),
            dislike: list(e.preferences?.dislike),
            nightEnabled: e.night?.enabled !== false,
            windowText: j.windowText ?? "",
            personality: e.enablePersonalityLearning !== false,
            switches: Object.fromEntries(SWITCHES.map(([k]) => [k, e[k] === true])),
            model: e.model ?? { provider: "", model: "", reasoningEffort: "" },
            owner: e.owner ?? { mid: "", name: "" },
            share: e.share ?? { enabled: true },
            listen: e.listen ?? {},
            // 安全词存成**原始文本**（list() 只是把数组换成「、」连接的形式）
            replyAutoApprove: e.reply?.autoApprove === true,
            replyText: list(e.reply?.safetyWords),
          });
          setInfo(j);
        } catch (e) {
          setErr("读取设置失败：" + e.message);
        }
      }, []);

      const loadStatus = useCallback(async () => {
        try { setStatus(await get("/status")) } catch (e) { setErr("读取状态失败：" + e.message) }
      }, []);

      useEffect(() => { load(); loadStatus(); }, [load, loadStatus]);

      const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
      const setSw = (k, v) => setForm((f) => ({ ...f, switches: { ...f.switches, [k]: v } }));

      const save = async () => {
        if (!form) return;
        setBusy("save"); setErr(""); setMsg("");
        try {
          await post("/settings", {
            persona: { name: form.name.trim(), ownerTitle: form.ownerTitle.trim() || "主人" },
            preferences: { like: parseList(form.like), dislike: parseList(form.dislike) },
            night: { enabled: !!form.nightEnabled },
            windowText: form.windowText.trim(),
            enablePersonalityLearning: !!form.personality,
            model: form.model,
            owner: form.owner,
            share: form.share,
            listen: form.listen,
            reply: {
              autoApprove: form.replyAutoApprove === true,
              safetyWords: parseList(form.replyText),
            },
            ...Object.fromEntries(SWITCHES.map(([k]) => [k, !!form.switches[k]])),
          });
          setMsg("已保存并生效 ✓（不用重启 DSH）");
          await load(); await loadStatus();
        } catch (e) {
          setErr("保存失败：" + e.message);
        } finally { setBusy("") }
      };

      /**
       * 测试：让她现在就去逛一遍 B 站，把当前激活的功能都跑一遍。
       * 宿侧保证**只读** + **不计入当天额度**（跑完还原账本）✓
       */
      const runTest = async () => {
        setBusy("test"); setErr(""); setMsg(""); setTestSteps(null); setTestArtifacts(null);
        try {
          const j = await post("/selftest", {});
          if (!j.ok) throw new Error(j.error || "自检失败");
          setTestSteps(j.steps ?? []);
          setTestArtifacts(j.artifacts ?? []);
          const made = (j.artifacts ?? []).filter((a) => a.ok).length;
          setMsg(
            "测试跑完" + (made ? " · 真的产出了 " + made + " 项（下面能核对）" : " · 没有产出，看下面原因") +
            (j.quotaRestored ? " · 额度已还原 ✓" : " · ⚠️ 额度还原失败"),
          );
          await loadStatus();
        } catch (e) {
          setErr("测试失败：" + e.message);
        } finally { setBusy("") }
      };

      if (err && !form) return h("div", { className: "bfm" }, h("div", { className: "bfm-err" }, err));
      if (!form) return h("div", { className: "bfm" }, h("div", { className: "bfm-hint" }, "读取中…"));

      const j = status?.journals;
      const w = status?.writes;

      // 顶部吸顶条：标题在左；「重新读取 / 测试 / 保存」在**右上角** ✓
      // ⚠️ 顺序按主人要求：测试在保存**左边** ✓
      const bar = h(
        "div",
        { className: "bfm-bar" },
        h("h2", { className: "bfm-bar-title" }, "刷B站"),
        h("div", { className: "bfm-bar-actions" },
          busy === "save" ? h("span", { className: "bfm-hint" }, "保存中…") : null,
          h("button", { className: "bfm-btn bfm-btn2", onClick: () => { load(); loadStatus() }, disabled: !!busy }, "重新读取"),
          h("button", { className: "bfm-btn bfm-btn2", onClick: runTest, disabled: !!busy },
            busy === "test" ? "测试中…" : "测试"),
          h("button", { className: "bfm-btn", onClick: save, disabled: !!busy }, "保存")),
      );

      // 自检结果面板：先列**产出物**（能不能验证就看这个），再列每项检查
      const testPanel = testSteps
        ? h(
            "div",
            { className: "bfm-day", style: { marginTop: "10px" } },
            h("div", { className: "bfm-day-head", style: { cursor: "default" } },
              h("span", null, "测试结果"),
              h("span", { className: "bfm-day-count" },
                testSteps.filter((s) => s.ok).length + " / " + testSteps.length + " 项通过")),
            h("div", { className: "bfm-day-body" },
              testArtifacts && testArtifacts.length
                ? h("div", null,
                    h("div", { className: "bfm-label", style: { marginTop: "8px" } }, "这次真的产出了："),
                    ...testArtifacts.map((a, i) =>
                      h("div", { className: "bfm-row", key: "a" + i },
                        h("div", null,
                          h("div", { className: "bfm-label" }, (a.ok ? "✓ " : "✗ ") + a.what),
                          h("div", { className: "bfm-hint" }, a.note || "")),
                        a.where && a.where.startsWith("http")
                          ? h("a", { className: "bfm-btn bfm-btn2 bfm-btn-sm", href: a.where, target: "_blank", rel: "noreferrer" }, "打开")
                          : a.where
                            ? h("div", { className: "bfm-mono" }, a.where)
                            : null)),
                    h("div", { className: "bfm-hint", style: { marginTop: "8px" } },
                      "评论那一条没写（写入没开），其余都是只读检查，没动过账号。"))
                : null,
              ...testSteps.map((s, i) =>
                h("div", { className: "bfm-row", key: i },
                  h("div", null,
                    h("div", { className: "bfm-label" }, (s.ok ? "✓ " : "✗ ") + s.name),
                    s.detail ? h("div", { className: "bfm-hint" }, s.detail) : null)))),
          )
        : null;

      return h(
        "div",
        { className: "bfm" },
        bar,
        h("p", { className: "bfm-intro" },
          "她会自己醒来、读点东西、写想写的；没有新发现是合法结果。",
          "下面的开关只是「允许她考虑」，不是「让她去做」。"),

        err ? h("div", { className: "bfm-err" }, err) : null,
        msg ? h("div", { className: "bfm-ok" }, msg) : null,
        testPanel,

        h("div", { className: "bfm-group" }, "她是谁"),
        h("div", { className: "bfm-rows" },
          Row({ label: "角色名", hint: "叫醒她时会提到", children: h(Input, { value: form.name, onChange: (v) => set("name", v), placeholder: "例如 助手" }) }),
          Row({ label: "她怎么称呼你", hint: "写信和叫醒时用", children: h(Input, { value: form.ownerTitle, onChange: (v) => set("ownerTitle", v), placeholder: "主人" }) })),

        h("div", { className: "bfm-group" }, "她用哪个模型"),
        h(ModelBox, { form, set }),

        h("div", { className: "bfm-group" }, "登录凭证"),
        h("div", { className: "bfm-rows" },
          Row({ label: "凭据文件", hint: "本插件自己的文件，不和养鱼共用", children: h("div", { className: "bfm-mono" }, info?.readonly?.credentialPath || "（未配置）") })),
        h(LoginBox),

        h("div", { className: "bfm-group" }, "她喜欢看什么"),
        h("div", { className: "bfm-rows" },
          Row({ label: "爱看", hint: "用「、」分隔；挑候选用", children: h(Input, { value: form.like, onChange: (v) => set("like", v), placeholder: "AI 工具、猫咪、任天堂" }) }),
          Row({ label: "不想看", hint: "只作排除参考", children: h(Input, { value: form.dislike, onChange: (v) => set("dislike", v), placeholder: "带货、标题党" }) })),

        h("div", { className: "bfm-group" }, "作息"),
        h("div", { className: "bfm-rows" },
          Row({ label: "自己醒来", hint: "关掉 = 只在对话里被叫到才动", children: h(Check, { checked: form.nightEnabled, onChange: (v) => set("nightEnabled", v) }) }),
          Row({ label: "可以醒的时段", hint: "格式 20:00-23:00，多段用逗号分隔", children: h(Input, { value: form.windowText, onChange: (v) => set("windowText", v), placeholder: "20:00-23:00, 10:30-12:00" }) })),

        h("div", { className: "bfm-group" }, "全天监听（别人找她）"),
        h(ListenBox, { form, set, status }),

        h("div", { className: "bfm-group" }, "说话能力（默认全关）"),
        h("div", { className: "bfm-hint", style: { marginBottom: "4px" } },
          "打开只是让工具能用。真要发出去，还需要本地授权文件 write-policy.json：",
          "写清楚账号、有效期、目标白名单和额度。缺一样都发不出去。"),
        h("div", { className: "bfm-rows" },
          ...SWITCHES.map(([k, label, hint]) => Row({ label, hint, children: h(Check, { checked: form.switches[k], onChange: (v) => setSw(k, v) }) })),
          Row({ label: "主人 mid", hint: "分享型评论 @ 的人", children: h(Input, { value: form.owner.mid, onChange: (v) => set("owner", { ...form.owner, mid: v }), placeholder: "28645724", width: "180px" }) }),
          Row({ label: "主人昵称", hint: "@ 时写进正文", children: h(Input, { value: form.owner.name, onChange: (v) => set("owner", { ...form.owner, name: v }), placeholder: "示例用户", width: "180px" }) }),
          Row({ label: "允许分享给我", hint: "关掉 = 她只看不说", children: h(Check, { checked: form.share.enabled !== false, onChange: (v) => set("share", { ...form.share, enabled: v }) }) })),

        h("div", { className: "bfm-group" }, "待审核的回复"),
        h("div", { className: "bfm-hint", style: { marginBottom: "4px" } },
          "她回别人之前，草稿先出现在这里。你点头才发 —— 这条不能省。"),
        h(PendingBox),

        h("div", { className: "bfm-group" }, "她最近做了什么"),
        h("div", { className: "bfm-hint", style: { marginBottom: "4px" } },
          "看了什么视频、发了什么评论、点赞/收藏了什么 —— 都在这里。按日期折叠，点链接能直接打开原视频。"),
        h(ActivityBox),

        /*
         * 信和日记搬去世界了（2026-11-08）。
         * 这里不再显示它们 —— 世界插件的设置里有单独的「她写的信」一页，
         * 日记也在世界那边写。刷 B站 这件事只留「刷」。
         */
        h("div", { className: "bfm-group" }, "她最近做了什么"),
        h("div", { className: "bfm-hint", style: { marginBottom: "4px" } },
          "这些就是她写日记的素材 —— 每一条都会自动进世界的记忆（is_test 的测试记录除外）。"),
        h(ActivityBox),

        h("div", { className: "bfm-group" }, "接入的是哪个她"),
        h("div", { className: "bfm-hint", style: { marginBottom: "4px" } },
          "叫醒、读片发到哪个会话 —— 必须是家里那个她，不是插件另开的窗口。"),
        h("div", { className: "bfm-rows" },
          Row({
            label: "叫醒发往",
            hint:
              status?.session?.state === "confirmed"
                ? "已经在往这个会话发了：记忆读写、亲自刷视频的都是家里的她"
                : status?.session?.state === "found"
                  ? "找到了家会话，但还没叫过一次 —— 点下面那个按钮就能确认"
                  : "⚠️ 没找到家会话 —— 现在用的是插件自建的独立会话，不是家里的她",
            children: h("div", { className: "bfm-mono" },
              status?.session?.state === "confirmed"
                ? "✅ " + (status.session.homeTitle ? status.session.homeTitle + " · " : "") + status.session.sessionId
                : status?.session?.state === "found"
                  ? "○ " + (status.session.homeTitle ? status.session.homeTitle + " · " : "") + status.session.homeSessionId + "（待确认）"
                  : "（未接入）" + (status?.session?.sessionId ? " · 用着 " + status.session.sessionId : "")),
          }),
          Row({
            label: "世界",
            hint: "读它的 life.json 找家会话",
            children: h("div", { className: "bfm-mono" }, status?.session?.homeWorldId ?? "default"),
          })),
        h("div", { className: "bfm-actions", style: { marginTop: "8px" } },
          h("button", {
            className: "bfm-btn bfm-btn-sm",
            disabled: !!busy,
            onClick: async () => {
              setBusy("wake-now");
              setMsg("");
              try {
                const out = await post("/wake-now", {});
                if (out?.ok) {
                  setMsg(
                    out.wiredHome
                      ? "已叫醒一次 → 家会话 " + (out.sessionId ?? "") + "。她会在她自己的对话框里动，不会另开窗口。"
                      : "已叫醒一次，但没接到家会话，用的是插件自建会话：" + (out.sessionId ?? "") + "。",
                  );
                } else {
                  setMsg("没叫起来：" + (out?.error ?? "未知原因"));
                }
                await load();
              } catch (e) {
                setMsg("没叫起来：" + String(e?.message ?? e));
              } finally {
                setBusy("");
              }
            },
          }, "现在叫她刷一次")),
        h("div", { className: "bfm-hint" }, "走的是同一套叫醒词和同一个目标会话，只是不等 20:38 那一刻 —— 用来当场确认「刷的是不是家里的她」。"),

        h("div", { className: "bfm-group" }, "当前状态"),
        h("div", { className: "bfm-rows" },
          Row({ label: "刷到什么去哪了", hint: "活动账本 → 世界记忆", children: h("div", { className: "bfm-label" }, "自动，不用管") }),
          Row({ label: "读取暂停", hint: "撞风控会自动暂停；只有本地 CLI 能解除", children: h("div", { className: "bfm-label" }, status?.pause ? "已暂停 · " + (status.pause.reason ?? "") : "正常") }),
          Row({ label: "已启用的写入", hint: "空 = 一个都没开（默认）", children: h("div", { className: "bfm-label" }, w?.enabled?.length ? w.enabled.join("、") : "无") })),

        h("div", { className: "bfm-group" }, "路径（只读）"),
        h("div", { className: "bfm-rows" },
          Row({ label: "数据目录", children: h("div", { className: "bfm-mono" }, info?.readonly?.dataDir ?? "—") }),
          Row({ label: "写入授权", hint: "不存在 = 任何写入都开不了", children: h("div", { className: "bfm-mono" }, info?.readonly?.writePolicyPath || "（未配置）") }),
          Row({ label: "设置覆盖层", children: h("div", { className: "bfm-mono" }, info?.settingsPath ?? "—") })),
        h("div", { className: "bfm-hint", style: { marginTop: "8px" } },
          "路径和凭据不在这里改 —— 能改它们就等于能绕过安全检查。要改请编辑 ~/.dsh/profiles/desktop/cordis.patch.yml。"),

        // 底部再来一条，滚到底也不用往回滚 ✓
        h("div", { className: "bfm-actions", style: { marginTop: "22px" } },
          h("button", { className: "bfm-btn", onClick: save, disabled: !!busy }, "保存")),
      );
    }

    const inject = ["slots"];
    const NS = "bili-fishman";
    const NAMES = { nav: "刷B站" };

    function apply(ctx) {
      /**
       * 用生成器交出注册结果，不要用箭头函数直接返回 register()。
       *
       * register() 返回的是 disposer；箭头函数把它原样返回，Cordis 就会把它
       * 当成「销毁函数」，注册在完成的同一拍被撤销 —— 页签还在，内容是空的。
       * 生成器是 iterable，走的是「事务化安装」那条分支。
       */
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", function* () {
            yield ctx.slots.register(
              { name: "settings.section", id: NS, order: 7, label: () => NAMES.nav },
              FishmanSection,
            );
          }),
        "bili-fishman: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.FishmanSection = FishmanSection;
    return module.exports;
  },
});