import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");

/**
 * 一个够用的迷你 React：能 useState / useEffect，能在 promise 落定后重渲染。
 * 目的只有一个 —— 真的把设置页渲染一次，看树上有没有那几段字。
 */
function createRuntime(fetchImpl) {
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false),
  });
  const slots = [];
  let cursor = 0;
  let effects = [];
  let firstRender = true;
  let definition;
  const React = {
    createElement: h,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => (slots[cursor++] ??= { current: init }),
    useState(init) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof init === "function" ? init() : init;
      const set = (next) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      };
      return [slots[index], set];
    },
    useEffect(fn) {
      if (firstRender) effects.push(fn);
    },
  };
  vm.runInNewContext(
    source,
    {
      window: { __ModuleLoader__: { load: (value) => { definition = value; } } },
      fetch: fetchImpl,
      AbortSignal: { timeout: () => undefined },
      Set, Map, JSON, String, Number, Boolean, Array, Object, Error, Promise, Date, Math, RegExp, console, setTimeout, clearTimeout, setInterval, clearInterval,
      document: { head: { appendChild: () => {} }, createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {} }), getElementById: () => null, querySelector: () => null },
    },
    { filename: "client.js" },
  );
  const plugin = definition.factory((name) => {
    if (name === "react") return React;
    throw new Error("unexpected dependency " + name);
  });
  async function render(tree) {
    for (let round = 0; round < 8; round++) {
      cursor = 0;
      const out = plugin.FishmanSection();
      firstRender = false;
      const pending = effects;
      effects = [];
      for (const fn of pending) fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 状态可能在 promise 里被写上去了，再来一轮直到稳定
      if (round > 0) return out;
    }
    return plugin.FishmanSection();
  }
  return { h, plugin, render, definition };
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) collectText(item, out); return out; }
  if (typeof node === "object") collectText(node.children, out);
  return out;
}

const settingsBody = {
  ok: true,
  editable: { persona: { name: "蓝星钥", ownerTitle: "主人" }, preferences: {}, night: { enabled: true }, listen: {}, reply: {}, owner: {}, share: {}, model: {} },
  readonly: { dataDir: "D:\\data" },
  windowText: "19:00-23:00",
};
const statusBody = {
  ok: true,
  session: {
    homeWorldId: "default",
    useHomeSession: true,
    // confirmed = 已经真的往这个会话发过话（界面上显示 ✅）
    state: "confirmed",
    homeSessionId: "session-0ad11298",
    sessionId: "session-0ad11298",
    wiredHome: true,
    homeTitle: "蓝星钥",
  },
  journals: { used: 0, limit: 2 },
  letters: { count: 0 },
  writes: {},
  pause: null,
};

function fakeFetch(url) {
  const body = String(url).includes("/status") ? statusBody : settingsBody;
  return Promise.resolve({ ok: true, json: async () => body, status: 200 });
}

test("客户端以 dsh-bili-fishman 身份挂设置段，导航名是「刷B站」", () => {
  const { plugin, definition } = createRuntime(fakeFetch);
  assert.equal(definition.id, "dsh-bili-fishman");
  let registered;
  plugin.apply({
    effect: (fn) => fn(),
    slots: {
      inject(name, factory) {
        assert.equal(name, "settings.section");
        for (const item of factory()) void item;
      },
      register(options, view) { registered = { options, view }; return () => {}; },
    },
  });
  assert.equal(registered.options.id, "bili-fishman");
  assert.equal(registered.options.label(), "刷B站");
  assert.equal(registered.view, plugin.FishmanSection);
});

test("真的渲染一次：页面上写着接入的家会话是哪一个", async () => {
  const { render } = createRuntime(fakeFetch);
  const tree = await render();
  const text = collectText(tree).join(" | ");
  assert.ok(text.includes("接入的是哪个她"), "缺「接入的是哪个她」这一段");
  assert.ok(text.includes("叫醒发往"), "缺「叫醒发往」那一行");
  assert.ok(text.includes("蓝星钥"), "接了家会话就该把标题显示出来");
  assert.ok(text.includes("session-0ad11298"), "接了家会话就该把会话 id 显示出来");
  assert.ok(text.includes("现在叫她刷一次"), "缺「现在叫她刷一次」按钮");
});

test("没接上家会话时，页面明确说未接入，而不是假装接上了", async () => {
  const off = (url) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => String(url).includes("/status")
        ? { ok: true, session: { homeWorldId: "default", state: "none", wiredHome: false, sessionId: "bili-fishman", homeTitle: "" }, journals: {}, letters: {}, writes: {} }
        : settingsBody,
    });
  const { render } = createRuntime(off);
  const text = collectText(await render()).join(" | ");
  assert.ok(text.includes("未接入"), "必须明说未接入");
  assert.ok(text.includes("bili-fishman"), "要说清现在用的是哪个会话");
});