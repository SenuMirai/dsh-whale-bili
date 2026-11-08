import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");

/**
 * 一个真的会重渲染的迷你 React。
 *
 * 为什么要这么麻烦：2026-11-08 那次「鱼与人设置页什么都不显示」，
 * 根因就是 ListenBox 里有一个没定义的 autoApprove —— 组件一渲染就抛
 * ReferenceError，宿主把整段 settings.section 顶掉，页面上只剩空白。
 * 那种错在静态检查里看不出来（不是语法错），必须**真的渲染一次**才抓得到。
 */
function createRuntime(statusBody, settingsBody) {
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false),
  });
  let cells = [];
  let cursor = 0;
  let effects = [];
  let first = true;
  let definition;
  const React = {
    createElement: h,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => (cells[cursor++] ??= { current: init }),
    useState(init) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof init === "function" ? init() : init;
      return [cells[index], (next) => { cells[index] = typeof next === "function" ? next(cells[index]) : next; }];
    },
    useEffect(fn) { if (first) effects.push(fn); },
  };
  vm.runInNewContext(
    source,
    {
      window: { __ModuleLoader__: { load: (value) => { definition = value; } } },
      fetch: (url) => Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/status") ? statusBody : settingsBody),
      }),
      AbortSignal: { timeout: () => undefined },
      Set, Map, JSON, String, Number, Boolean, Array, Object, Error, Promise, Date, Math, RegExp, console,
      setTimeout, clearTimeout, setInterval, clearInterval,
      document: {
        head: { appendChild: () => {} },
        createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {} }),
        querySelector: () => null,
      },
    },
    { filename: "client.js" },
  );
  const plugin = definition.factory((name) => {
    if (name === "react") return React;
    throw new Error("unexpected dependency " + name);
  });
  return {
    plugin,
    async render() {
      let tree;
      for (let round = 0; round < 4; round++) {
        cursor = 0;
        tree = plugin.FishmanSection();
        first = false;
        const pending = effects;
        effects = [];
        for (const fn of pending) fn();
        await new Promise((resolve) => setTimeout(resolve, 0));
        cells = [...cells];
      }
      return tree;
    },
  };
}

/**
 * 真的把树走完：遇到函数组件就调用它（和 React 一样）。
 * 少了这一步，组件内部的 ReferenceError 会被漏掉 —— 而那正是空白页的根因。
 */
function text(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) text(item, out); return out; }
  if (typeof node !== "object") return out;
  if (typeof node.type === "function") {
    const rendered = node.type({ ...node.props, children: node.children });
    text(rendered, out);
    return out;
  }
  text(node.children, out);
  return out;
}

const settings = {
  ok: true,
  editable: {
    persona: { name: "蓝星钥", ownerTitle: "主人" },
    preferences: { like: [], dislike: [] },
    night: { enabled: true, windows: [{ start: "19:00", end: "23:00" }] },
    model: { provider: "workbuddy", model: "x" },
    owner: { mid: "1", name: "主人" },
    share: { enabled: true },
    listen: { enabled: true, intervalSec: 300, dailyMax: 10, perPersonMax: 2, perPersonDays: 30, perVideoMax: 3, scope: "both", allDay: false },
    reply: { autoApprove: true, safetyWords: ["API", "密码"] },
    enablePersonalityLearning: true,
  },
  readonly: { dataDir: "D:/data", credentialPath: "D:/cred", writePolicyPath: "D:/policy" },
  windowText: "19:00-23:00",
};

const baseStatus = {
  ok: true,
  journals: { used: 0, limit: 2 },
  letters: { count: 3 },
  writes: { enabled: [] },
  pause: null,
  listen: { replies: 1, dailyMax: 10 },
  model: { provider: "workbuddy", model: "x", source: "config" },
};

test("⭐ 整段设置页必须能真的渲染出来（缺一个变量就会整块消失）", async () => {
  const rt = createRuntime(
    { ...baseStatus, session: { homeWorldId: "default", state: "confirmed", homeSessionId: "s1", sessionId: "s1", wiredHome: true, homeTitle: "蓝星钥" } },
    settings,
  );
  const tree = await rt.render();
  const content = text(tree).join(" | ");
  // 这些是页面每一段的分界，任何一段没渲染出来都说明有组件炸了
  for (const marker of ["她是谁", "作息", "全天监听（别人找她）", "接入的是哪个她", "当前状态"]) {
    assert.ok(content.includes(marker), "这一段没渲染出来：" + marker);
  }
  // ListenBox 里那个 autoApprove 就是空白页的元凶 —— 它渲染出来才算过关
  assert.ok(content.includes("开启全天监听"), "监听那一段没出来");
  assert.ok(content.includes("免审核直接回"), "免审核那一行没出来（autoApprove 又没定义了）");
  assert.ok(content.includes("安全词"), "安全词那一段没出来");
});

test("三道状态：confirmed / found / none 说法必须不一样", async () => {
  for (const [state, expect] of [
    ["confirmed", "已经在往这个会话发了"],
    ["found", "找到了家会话，但还没叫过一次"],
    ["none", "没找到家会话"],
  ]) {
    const rt = createRuntime(
      { ...baseStatus, session: { homeWorldId: "default", state, homeSessionId: state === "none" ? null : "s1", sessionId: state === "none" ? "bili-fishman" : "s1", wiredHome: state !== "none", homeTitle: state === "none" ? "" : "蓝星钥" } },
      settings,
    );
    const content = text(await rt.render()).join(" | ");
    assert.ok(content.includes(expect), state + " 的说明不对：" + content.slice(0, 200));
  }
});