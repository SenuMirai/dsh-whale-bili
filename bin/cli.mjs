#!/usr/bin/env node
// 本地 CLI —— 不消耗模型额度，直接看/改本地账本。
//
// 用法：
//   node bin/cli.mjs status
//   node bin/cli.mjs read BVxxxxxxxxxx [page]
//   node bin/cli.mjs inbox
//   node bin/cli.mjs letters
//   node bin/cli.mjs day [YYYY-MM-DD]
//   node bin/cli.mjs personality read
//   node bin/cli.mjs memory list
//
// 凭据：设 BILI_FISHMAN_CREDENTIAL_FILE 指向本地 JSON（字段 sessdata）。
//       ⚠️ 不要把凭据值放到命令行、对话或任何公开地方。
//
// 本 CLI 与 DSH 插件共用同一份 dataDir。

import { Service } from "../lib/service.mjs";
import { safeError } from "../lib/errors.mjs";
import { resolveUnknown, resumeWrites } from "../lib/talk.mjs";
import { resolveUnknown as resolvePlatformUnknown, resumeWrites as resumePlatformWrites } from "../lib/writer.mjs";
import { linkPersonality } from "../lib/personality.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const config = (() => {
  const file = process.env.BILI_FISHMAN_CONFIG_FILE;
  if (file) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* 落到默认 */
    }
  }
  return {};
})();

const credentialPath =
  process.env.BILI_FISHMAN_CREDENTIAL_FILE || config.credentialPath || "";

const dataDir =
  config.dataDir ||
  join(process.env.DSH_HOME || join(homedir(), ".dsh"), "bili-fishman");

const service = new Service({ ...config, dataDir, credentialPath });

const out = (v) => console.log(JSON.stringify(v, null, 2));

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(
      [
        "用法: node bin/cli.mjs <命令>",
        "",
        "── 看和记（不需要授权）──",
        "  status                    看状态（暂停 / 任务 / 信 / 日子 / 写入开关）",
        "  read <BV> [page]          读一个视频的文字稿",
        "  candidates [n]            捞几条候选（可能一条都没有）",
        "  inbox                     看信笺收件箱",
        "  letters [n]               看写给主人的信",
        "  day [YYYY-MM-DD]          看某天（默认今天）",
        "  days [n]                  看最近几天",
        "  personality read          看人格札记",
        "  memory list               看记忆",
        "",
        "── 只有人能做的事（模型工具没有这些）──",
        "  consumed <readingId> <秒>  确认「我确实看了这么多秒」（历史写入的前提）",
        "  write-resolve <id> applied|not-applied",
        "                            核对一条「结果不明」的写入",
        "  write-resume              解除账号写入暂停（要先处理完 pending）",
        "  personality link <文件>   给 AGENTS.local.md 装人格读取入口",
        "",
        "凭据：BILI_FISHMAN_CREDENTIAL_FILE=<本地 json 路径>",
        "配置：BILI_FISHMAN_CONFIG_FILE=<本地 json 路径>",
        "",
        "⚠️ 写入开关和授权文件都在配置/本地文件里，模型无法自己打开。",
      ].join("\n"),
    );
    process.exitCode = 0;
  } else if (cmd === "consumed") {
    const [readingId, seconds] = rest;
    if (!readingId || !seconds)
      throw Object.assign(new Error("用法: consumed <readingId> <秒数>"), { code: "INVALID_CONSUMPTION_PROGRESS" });
    out(service.confirmConsumption(readingId, Number(seconds)));
  } else if (cmd === "write-resolve") {
    const [id, outcome] = rest;
    if (!id || !outcome)
      throw Object.assign(new Error("用法: write-resolve <operationId> applied|not-applied"), { code: "INVALID_WRITE_OUTCOME" });
    // 表达类和平台类各有一套账本，先试表达类
    let r;
    try {
      r = resolveUnknown(config, id, outcome);
    } catch {
      r = resolvePlatformUnknown(config, id, outcome);
    }
    out(r);
  } else if (cmd === "write-resume") {
    let r;
    try {
      r = resumeWrites(config);
    } catch {
      r = resumePlatformWrites(config);
    }
    out(r);
  } else if (cmd === "personality" && rest[0] === "link") {
    const target = rest[1];
    if (!target)
      throw Object.assign(new Error("用法: personality link <AGENTS.md|AGENTS.local.md>"), { code: "INVALID_INSTRUCTION_FILE" });
    out({ target, status: linkPersonality(target) });
  } else if (cmd === "status") {
    out(service.status());
  } else if (cmd === "read") {
    const [video, page] = rest;
    if (!video) throw Object.assign(new Error("需要 BV"), { code: "INVALID_VIDEO" });
    const r = await service.read(video, page ? Number(page) : undefined);
    out(r.result);
  } else if (cmd === "candidates") {
    const r = await service.candidates(rest[0] ? Number(rest[0]) : 5);
    out(r.result);
  } else if (cmd === "inbox") {
    out(service.inbox({}));
  } else if (cmd === "letters") {
    out(service.letters(rest[0] ? Number(rest[0]) : 20));
  } else if (cmd === "day") {
    const d = rest[0];
    const days = service.days(3650);
    const hit = d ? days.find((x) => x.date === d) : days[0];
    out(hit ?? { date: d ?? null, mood: null, note: null, empty: true });
  } else if (cmd === "days") {
    out({ days: service.days(rest[0] ? Number(rest[0]) : 30) });
  } else if (cmd === "personality") {
    out(service.personality(rest[0] || "read", {}));
  } else if (cmd === "memory") {
    out(service.memory(rest[0] || "list", rest[1] || "", null));
  } else {
    console.error(`未知命令: ${cmd}\n跑 "node bin/cli.mjs help" 看清单。`);
    process.exitCode = 2;
  }
} catch (e) {
  out(safeError(e));
  process.exitCode = 1;
} finally {
  try {
    service.close();
  } catch {
    /* 已关 */
  }
}
