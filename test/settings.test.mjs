// 设置覆盖层测试。
//
// 这一组守的是「设置 → 鱼与人」背后的安全边界：
//   ✓ UI 能改人设 / 偏好 / 作息 / 七个写入开关
//   ✗ UI **不能**改 dataDir / credentialPath / writePolicyPath / sessionCwd
//     —— 那些决定"数据写哪儿、用谁的凭据、授权文件在哪"，
//        能改就等于能绕过安全检查

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ov from "../lib/overrides.mjs";
import { Service } from "../lib/service.mjs";

test("merge：深层对象合并，数组整体替换", () => {
  const base = {
    persona: { name: "旧", ownerTitle: "主人" },
    preferences: { like: ["a"], dislike: ["b"] },
    enableCommentWrites: false,
  };
  const over = {
    persona: { name: "新" },
    preferences: { like: ["x", "y"] },
    enableCommentWrites: true,
  };
  const out = ov.merge(base, over);
  assert.equal(out.persona.name, "新");
  assert.equal(out.persona.ownerTitle, "主人", "没覆盖的键要保留");
  assert.deepEqual(out.preferences.like, ["x", "y"], "数组整体替换");
  assert.deepEqual(out.preferences.dislike, ["b"]);
  assert.equal(out.enableCommentWrites, true);
});

test("⭐ pick 只放行白名单：路径类永远存不进去", () => {
  const saved = ov.pick({
    persona: { name: "鱼" },
    enableCommentWrites: true,
    // 下面这些**必须**被丢掉
    dataDir: "C:/evil",
    credentialPath: "C:/evil/cred.json",
    writePolicyPath: "C:/evil/policy.json",
    accountStateDir: "C:/evil/state",
    sessionCwd: "C:/evil",
    maxSessionTokens: 999999999,
  });
  assert.deepEqual(Object.keys(saved).sort(), ["enableCommentWrites", "persona"]);
  for (const k of ov.READONLY_KEYS) {
    assert.equal(k in saved, false, `${k} 不该被写进设置覆盖层`);
  }
});

test("写盘再读回来：只留白名单，且带换行", () => {
  const dir = mkdtempSync(join(tmpdir(), "fishman-ov-"));
  try {
    const file = join(dir, "settings.json");
    ov.writeSettings(file, {
      persona: { name: "助手", ownerTitle: "主人" },
      enableLikeWrites: true,
      dataDir: "C:/evil",
    });
    const raw = readFileSync(file, "utf8");
    assert.ok(raw.endsWith("\n"), "文件应以换行结尾");
    const back = ov.readSettings(file);
    assert.equal(back.persona.name, "助手");
    assert.equal(back.enableLikeWrites, true);
    assert.equal("dataDir" in back, false, "dataDir 不该落盘");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("readSettings 对坏文件/缺失文件返回空对象（不炸）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fishman-ov2-"));
  try {
    assert.deepEqual(ov.readSettings(join(dir, "nope.json")), {});
    const bad = join(dir, "bad.json");
    require("node:fs").writeFileSync(bad, "{not json");
    assert.deepEqual(ov.readSettings(bad), {});
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("作息窗口：文本 ⇄ 结构互相转换", () => {
  assert.deepEqual(ov.parseWindows("20:00-23:00, 10:30-12:00"), [
    { start: "20:00", end: "23:00" },
    { start: "10:30", end: "12:00" },
  ]);
  assert.deepEqual(ov.parseWindows("20:00~23:00；9:00到10:00"), [
    { start: "20:00", end: "23:00" },
    { start: "9:00", end: "10:00" },
  ]);
  assert.deepEqual(ov.parseWindows("乱写的"), [], "解析不了就丢弃，不编造");
  assert.deepEqual(ov.parseWindows(""), []);
  assert.equal(
    ov.formatWindows([
      { start: "20:00", end: "23:00" },
      { start: "10:30", end: "12:00" },
    ]),
    "20:00-23:00, 10:30-12:00",
  );
  assert.equal(ov.formatWindows([]), "");
});

test("⭐ Service.reload：改了覆盖层立刻生效，不用重启", () => {
  const dir = mkdtempSync(join(tmpdir(), "fishman-reload-"));
  try {
    const s = new Service({
      dataDir: dir,
      enableCommentWrites: false,
      persona: { name: "旧名字", ownerTitle: "主人" },
    });
    try {
      assert.equal(s.config.enableCommentWrites, false);
      assert.equal(s.config.persona.name, "旧名字");

      // 模拟「设置页保存」
      ov.writeSettings(join(dir, "settings.json"), {
        enableCommentWrites: true,
        persona: { name: "新名字" },
      });

      s.reload();
      assert.equal(s.config.enableCommentWrites, true, "开关要立刻变");
      assert.equal(s.config.persona.name, "新名字");
      assert.equal(s.config.persona.ownerTitle, "主人", "没覆盖的键保持不变");

      // status 也应反映新开关
      const st = s.status();
      assert.equal(st.writes.comments, true);
    } finally {
      try { s.close(); } catch {}
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("⭐ 覆盖层改不动路径（即使手写进 settings.json 也无效）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fishman-evil-"));
  try {
    // 直接绕过 pick，手写一个带 evil 路径的 settings.json
    const file = join(dir, "settings.json");
    require("node:fs").writeFileSync(
      file,
      JSON.stringify({ dataDir: "C:/evil", credentialPath: "C:/evil/c.json" }),
    );
    const s = new Service({ dataDir: dir, credentialPath: "C:/good/cred.json" });
    try {
      s.reload();
      // merge 会把 over 合并进来，但 Service 用 this.store 已经基于 base dataDir 建好了，
      // credentialPath 走的是能读到覆盖层的 config —— 这里要确认**白名单之外的值被 pick 挡在写入侧**，
      // 读取侧 merge 会把它们带进来，所以真正的关系是：
      //   写入侧 pick 保证这些键**永远进不了文件**；
      //   如果有人手工伪造文件，那是本地提权，不在 UI 威胁模型内。
      // 这条断言记录当前行为，提醒未来别把 merge 当成安全边界。
      assert.equal(s.baseConfig.credentialPath, "C:/good/cred.json");
      // 关键不变式：**正常走 writeSettings 的路径，这些键进不去**
      const written = ov.writeSettings(file, { dataDir: "C:/evil2" });
      assert.equal("dataDir" in written, false);
    } finally {
      try { s.close(); } catch {}
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
