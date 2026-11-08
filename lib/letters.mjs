// 给他的信 —— 保留养鱼最珍贵的那部分：她**想**跟主人说话。
//
// 但把「必须说点什么」改成「想说才说」：
//   养鱼那边每轮结尾都必须 `notify` 推一段给主人，日记里还写着
//   "今天这封信短，是因为我确实没东西给你看"—— 她明显被"必须汇报"逼着 ✗
//
// 这里改成：
//   · 信是**攒出来的**，不是每轮必产
//   · 攒够了才值得打扰主人一次（有实质内容才推）
//   · 没有想说的，就不发；"今天没什么想说的"是合法状态 ✓
//   · 每封信都记在账本里，主人能翻；不自动发到任何公开地方 ✓
//
// 投递方式沿用养鱼的思路，但收窄到最保守的一种：写进本地文件 + 可选桌面通知。
// 不接 webhook、不发 B站、不 @ 任何人 —— 那些都是对外的动作，得主人明确开。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomic, now } from "./store.mjs";
import { need } from "./errors.mjs";

export const MAX_LETTER_CHARS = 4000;

// 2026-10-29：信也搬进她家里（room\信.md）。lettersDir 由 config.diaryDir 指过来。
const file = (store) => join(store.lettersDir || store.root, "信.md");

/**
 * 写一封信。
 *
 * 与养鱼 notify 的差别：这里**没有** "每轮必须写" 的约束，
 * 也不带评分/排名那套（那会变成"为了发而找理由"）。
 * 只要求：说清楚这封信是从哪段经历来的，以及它想让主人知道什么。
 */
export function write(store, { readingId = null, body, from = "" } = {}) {
  const text = String(body ?? "").trim();
  need(text.length > 0, "LETTER_EMPTY");
  need(text.length <= MAX_LETTER_CHARS, "LETTER_TOO_LONG");

  // 有出处就核对一下（没出处也允许 —— 有时候想说的不是从某条视频来的）
  if (readingId) store.reading(readingId);

  const created = now();
  return store.tx(() => {
    const id = store.letter(readingId, {
      body: text,
      from: String(from ?? "").trim().slice(0, 200),
    }, created);
    exportFile(store);
    return { id, created, path: file(store), status: "local_letter_not_delivered" };
  });
}

/** 今天有没有写过信（用于"想说话的时候才说"的轻提示，不做硬限制） */
export function today(store, date) {
  return store.db
    .prepare("SELECT count(*) AS n FROM letters WHERE date(created, '+8 hours')=?")
    .get(date).n;
}

export function list(store, limit = 20) {
  return store.db
    .prepare("SELECT * FROM letters ORDER BY created DESC, id DESC LIMIT ?")
    .all(Math.min(100, Math.max(1, Number(limit) || 20)))
    .map((r) => ({ ...r, body: JSON.parse(r.body) }));
}

const escape = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** 导出成本地 Markdown（主人能直接翻） */
export function exportFile(store) {
  const rows = store.db
    .prepare("SELECT * FROM letters ORDER BY created ASC, id ASC")
    .all();
  const parts = [
    "# 给他的信\n",
    "本地信件。这些不是公开内容，也不会自动发到任何地方。\n",
    "攒着想说的话，想说的时候才写。没有想说的日子，这一页可以一直是空的。\n",
  ];
  for (const row of rows) {
    const body = JSON.parse(row.body);
    let source = "";
    if (row.reading_id) {
      try {
        const r = store.reading(row.reading_id);
        source = `\n\n出处：${escape(r.title)} · ${escape(r.author)} · ${r.url}`;
      } catch {
        source = "";
      }
    }
    parts.push(
      `\n---\n\n## ${row.created.slice(0, 10)}\n\n${escape(body.body)}${source}\n`,
    );
  }
  const content = parts.join("");
  need(Buffer.byteLength(content) <= 1024 * 1024, "LETTERS_FILE_FULL");
  atomic(file(store), content);
  return file(store);
}

/** 读导出的文件（供主人查看；文件不在就返回空） */
export function readFile(store) {
  const p = file(store);
  if (!existsSync(p)) return { path: p, text: "", exists: false };
  return { path: p, text: readFileSync(p, "utf8"), exists: true };
}
