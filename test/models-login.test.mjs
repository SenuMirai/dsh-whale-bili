// 模型目录 + 扫码登录的单元测试。
//
// 这组守的是两件容易在真实环境里"默默坏掉"的事：
//   1. catalog / projcache 是外部文件，缺失或写坏时不能把设置页带崩；
//   2. 扫码成功的凭据只挂在 Set-Cookie 上，解错方向就会"扫码成功但登录不上"。
//
// 全部用临时目录和假 fetch，不碰网络、不写主人真实的数据目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listModels, sessionModel, wantedModel } from "../lib/models.mjs";
import { pollLogin, QR_FILE_NAME, startLogin } from "../lib/login.mjs";

function makeHome(prefix = "fishman-ml-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function drop(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

function writeCatalog(home, file, models) {
  writeFileSync(
    join(home, file),
    JSON.stringify({ entries: { e1: { models } } }),
    "utf8",
  );
}

function catalogModel(id, name, { free = false, contextWindow = null } = {}) {
  return { id, name, contextWindow, billing: { free } };
}

function fakePollResponse(body, cookies = []) {
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => cookies },
    json: async () => body,
  };
}

function fakeGenerateResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: {},
    json: async () => ({ code: 0, message: "0", data }),
  };
}

test("listModels：读出两个 provider，免费在前、按名字排序、按 provider::id 去重", () => {
  const home = makeHome();
  try {
    writeFileSync(
      join(home, ".workbuddy-catalog.json"),
      JSON.stringify({
        entries: {
          one: {
            models: [
              catalogModel("paid-z", "Zeta", { contextWindow: 1000 }),
              catalogModel("free-b", "Beta", { free: true, contextWindow: 2000 }),
              catalogModel("free-a", "Alpha", { free: true, contextWindow: 3000 }),
            ],
          },
          // 同一个模型会在多个 entry 里重复出现：这是目录的常态，不是数据错误。
          two: {
            models: [
              catalogModel("free-a", "Alpha（重复条目）", { free: false }),
              catalogModel("paid-y", "Yankee"),
            ],
          },
        },
      }),
      "utf8",
    );
    writeCatalog(home, ".workbuddy-ai-catalog.json", [
      catalogModel("free-a", "Alpha", { free: true }),
    ]);

    const out = listModels({
      dshHome: home,
      current: { provider: "workbuddy", model: "free-a" },
    });
    assert.equal(out.groups.length, 2);

    const wb = out.groups.find((g) => g.provider === "workbuddy");
    assert.ok(wb, "国内 provider 应该出现");
    assert.equal(wb.label, "WorkBuddy（国内版）");
    assert.deepEqual(
      wb.models.map((m) => m.id),
      ["free-a", "free-b", "paid-y", "paid-z"],
      "免费在前，同组按名字（Alpha/Beta/Yankee/Zeta）",
    );
    assert.equal(wb.models[0].free, true);
    assert.equal(wb.models[0].contextWindow, 3000, "重复条目不能覆盖先读到的元数据");
    assert.equal(
      wb.models.filter((m) => m.id === "free-a").length,
      1,
      "同一个 provider 内必须去重",
    );

    const intl = out.groups.find((g) => g.provider === "workbuddy-ai");
    assert.ok(intl, "国际 provider 应该出现");
    assert.equal(intl.label, "WorkBuddy AI（国际版）");
    assert.equal(intl.models.length, 1, "同一个 id 在不同 provider 下应各留一条");

    assert.deepEqual(out.current, {
      provider: "workbuddy",
      model: "free-a",
      source: "config",
    });
  } finally {
    drop(home);
  }
});

test("listModels：catalog 缺失 / 坏 JSON 只跳过那个 provider，不抛错", () => {
  const home = makeHome();
  try {
    assert.deepEqual(listModels({ dshHome: home }), {
      groups: [],
      current: { provider: "", model: "", source: "" },
    });

    // 国内坏、国际好：只应该看到国际
    writeFileSync(join(home, ".workbuddy-catalog.json"), "{这不是 JSON", "utf8");
    writeCatalog(home, ".workbuddy-ai-catalog.json", [
      catalogModel("intl-1", "Intl One", { free: true }),
    ]);
    const one = listModels({ dshHome: home });
    assert.deepEqual(
      one.groups.map((g) => g.provider),
      ["workbuddy-ai"],
    );
    assert.equal(one.groups[0].models[0].id, "intl-1");

    // 两个都坏 → 空列表，而不是 throw
    writeFileSync(join(home, ".workbuddy-ai-catalog.json"), "{也坏了", "utf8");
    assert.deepEqual(listModels({ dshHome: home }).groups, []);
  } finally {
    drop(home);
  }
});

test("sessionModel：从 projcache 的 lastUsed 读出 provider/model", () => {
  const home = makeHome();
  try {
    const sessions = join(home, "storages", "session_projcache", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "abc-123.json"),
      JSON.stringify({
        record: {
          rows: {
            modelSelection: {
              val: {
                lastUsed: {
                  provider: "workbuddy-ai",
                  model: "hy3",
                  reasoningEffort: "high",
                },
              },
            },
          },
        },
      }),
      "utf8",
    );

    assert.deepEqual(sessionModel({ dshHome: home, sessionId: "abc-123" }), {
      provider: "workbuddy-ai",
      model: "hy3",
    });
    assert.deepEqual(sessionModel({ dshHome: home, sessionId: "abc-123.json" }), {
      provider: "workbuddy-ai",
      model: "hy3",
    });
    assert.equal(sessionModel({ dshHome: home, sessionId: "missing" }), null);
    assert.equal(
      sessionModel({ dshHome: home, sessionId: "../abc-123" }),
      null,
      "路径穿越要挡住",
    );
  } finally {
    drop(home);
  }
});

test("wantedModel：没配返回 null，配了只给 provider/model", () => {
  assert.equal(wantedModel(undefined), null);
  assert.equal(wantedModel({}), null);
  assert.equal(wantedModel({ model: {} }), null);
  assert.equal(wantedModel({ model: { provider: "workbuddy", model: "" } }), null);
  assert.deepEqual(
    wantedModel({ model: { provider: " workbuddy ", model: " hy3 " } }),
    { provider: "workbuddy", model: "hy3" },
  );
});

test("pollLogin：86101/86090/86038/0 四种状态映射正确", async () => {
  for (const [code, state] of [
    [86101, "waiting"],
    [86090, "scanned"],
    [86038, "expired"],
  ]) {
    const seen = [];
    const out = await pollLogin({
      key: "k-1",
      fetch: async (url, opts) => {
        seen.push({ url, opts });
        return fakePollResponse({ code: 0, message: "", data: { code } });
      },
    });
    // 严格对齐返回契约：非成功态只有 ok/state，不夹带诊断字段
    assert.deepEqual(out, { ok: true, state });
    assert.equal(seen[0].opts.redirect, "manual", "必须禁止自动跟随 redirect");
    assert.match(seen[0].url, /qrcode_key=k-1/);
    assert.match(seen[0].url, /source=main-fe-header/);
  }

  // code 0 也要走通（凭据细节由下一条测试守）
  const ok = await pollLogin({
    key: "k-1",
    fetch: async () =>
      fakePollResponse(
        { code: 0, message: "0", data: { code: 0, url: "https://passport.biligame.com/x" } },
        [
          "SESSDATA=sess%2Cvalue; Path=/; Domain=.bilibili.com; HttpOnly",
          "bili_jct=csrf; Path=/",
          "DedeUserID=42; Path=/",
          "buvid3=buv-1; Path=/",
        ],
      ),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.state, "ok");
});

test("pollLogin：成功时从 Set-Cookie 解出 sessdata/bili_jct，缺 buvid3 时走 spi 补齐", async () => {
  const calls = [];
  const fetchFake = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("/x/frontend/finger/spi")) {
      return {
        ok: true,
        status: 200,
        headers: {},
        json: async () => ({ code: 0, data: { b_3: "buv-from-spi" } }),
      };
    }
    return fakePollResponse(
      { code: 0, message: "0", data: { code: 0, url: "https://passport.biligame.com/x" } },
      [
        "SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; HttpOnly",
        "bili_jct=tok+en; Path=/",
        "DedeUserID=98765; Path=/",
        "buvid4=ignore-me; Path=/",
      ],
    );
  };

  const out = await pollLogin({ key: "qr-key", fetch: fetchFake });
  assert.equal(out.ok, true);
  assert.equal(out.state, "ok");
  assert.equal(out.mid, "98765");
  assert.deepEqual(out.cred, {
    sessdata: "abc%2C123",
    bili_jct: "tok+en",
    buvid3: "buv-from-spi",
    dedeuserid: "98765",
  });
  assert.equal(calls.length, 2, "缺 buvid3 时应补一次 spi");
  assert.match(calls[1].url, /finger\/spi/);
  assert.equal(calls[0].opts.redirect, "manual");
});

test("pollLogin：没有 key 是调用方错误，抛带 code 的错", async () => {
  await assert.rejects(
    pollLogin({ key: "" }),
    (e) => e?.code === "LOGIN_KEY_REQUIRED",
  );
});

test("startLogin：生成 key/url；没给 filePath 时不画图，img 为 null", async () => {
  const calls = [];
  const out = await startLogin({
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return fakeGenerateResponse({
        qrcode_key: "qr-key",
        url: "https://passport.bilibili.com/qr?key=qr-key",
      });
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.key, "qr-key");
  assert.equal(out.url, "https://passport.bilibili.com/qr?key=qr-key");
  assert.equal(out.img, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /qrcode\/generate\?source=main-fe-header/);
});

test("startLogin：画二维码失败不算错，仍返回 url", async () => {
  const home = makeHome();
  try {
    const out = await startLogin({
      filePath: join(home, QR_FILE_NAME),
      fetch: async () =>
        fakeGenerateResponse({
          qrcode_key: "qr-key",
          url: "https://example.invalid/qr",
        }),
      // 指向一个不存在的解释器：模拟"没装 Python/qrcode"
      findPython: () => join(home, "python-does-not-exist-xyz"),
    });
    assert.equal(out.ok, true);
    assert.equal(out.img, null);
    assert.equal(out.url, "https://example.invalid/qr");
  } finally {
    drop(home);
  }
});
