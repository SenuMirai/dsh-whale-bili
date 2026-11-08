// 两本日记 —— 「她有自己的日子」这件事，落在纸上。
//
// 为什么是两本，而不是一本加隐私开关：
//   给主人看的那本要能读、要能被打动，所以它写「今天看见了什么、想了什么」；
//   只给自己看的那本要连自己都骗不过，所以它只写偏好校准 ——
//   哪条视频主人有反应、下次该往哪偏、自己哪里判断错了。
//   两本的读者不同，写坏的成本也不同；混在一本里，她就会开始为读者写作 ✗
//
// 为什么每天每本只留一篇：
//   日记不是流水账。同一天再写就覆盖，等于逼她在落笔前想清楚"今天到底想留下什么"，
//   而不是靠条目数证明今天有产出。
//
// 为什么表建在自己的构造函数里：
//   store.mjs 不归这本日记改。用 IF NOT EXISTS 建表，反复 new Diary 也安全；
//   也不去动 store 的 user_version —— 那等于替 store 做迁移，两处都改迁移迟早撞车。
//
// 为什么写库和导出是两件事：
//   库是唯一事实，Markdown 只是给主人和设置页看的副本。写日记这件事不该被
//   磁盘问题拖累，所以 write() 只落库；什么时候落盘由调用方显式调 exportFile 决定。

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, now } from "./store.mjs";
import { shDate } from "./clock.mjs";

export const MAX_DIARY_CHARS = 8000;
// 心情只是标题上的一个词，不该变成正文；超了安静截断，不为此拒掉一整篇。
export const MAX_MOOD_CHARS = 200;

// 错误照这里约定的形状走：Error + code。message 说人话，上层用 code 判断。
// 没有用 errors.mjs 的 need()：它只把 code 当 message，而这里的错需要讲清楚
// 是哪本日记、差多少字 —— 只回一个 DIARY_TOO_LONG 她不知道该怎么改。
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

const BOOKS = {
  open: {
    file: "diary.md",
    title: "她的日记（给主人看的）",
    intro: "本地文件。不会发到任何地方。",
  },
  private: {
    file: "diary-private.md",
    title: "她的日记（只给她自己）",
    // 只说实话：这本不被投递，但它仍是主人机器上的本地文件，不吹成"别人看不到"。
    intro: "本地文件。只给自己看：偏好校准，和判断错在哪。",
  },
};

/** kind 不认识时尽早炸，别让 SQLite 的 CHECK 约束抛一条她看不懂的错 */
function book(kind) {
  const b = BOOKS[kind];
  if (!b) fail("DIARY_KIND_INVALID", `没有这本日记：${kind}（只有 open 和 private）`);
  return b;
}

// 正文里的 < > 会被 markdown 当 HTML 吞掉，导出前统一转义。
// 只处理展示层，库里存的还是原样，所以读回来不会变形。
const escape = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export class Diary {
  constructor({ store, dir } = {}) {
    if (!store?.db) fail("DIARY_STORE_INVALID", "Diary 需要一个已经打开的 Store");
    this.store = store;
    // 目录默认为库所在目录，这样日记和 ledger.sqlite 待在一起，搬家只要搬一个地方。
    this.dir = resolve(dir || store.root);

    // IF NOT EXISTS：这个构造函数会被反复调用（服务重启、设置页刷新），
    // 任何一次都不该因为表已经在了就失败。
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS diary (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('open','private')),
        date TEXT NOT NULL,          -- YYYY-MM-DD, Asia/Shanghai
        mood TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        created TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS diary_date ON diary(kind, date);
    `);
  }

  /**
   * 写一篇。kind: 'open' | 'private'。
   *
   * 正文和心情至少有一个：允许"今天就是很累，不想写"——只写 mood 也合法。
   * 同一天同一本再写就覆盖（日记不是流水账），返回里用 overwritten 标出来。
   */
  write(kind, { mood = "", body = "" } = {}) {
    book(kind);
    const date = shDate();
    const moodText = String(mood ?? "").trim().slice(0, MAX_MOOD_CHARS);
    // 只掐掉首尾空白：中间的换行和缩进是她自己排的，一个字都不动。
    const bodyText = String(body ?? "").trim();

    // 按码点算长度：String.length 把一个 emoji 记成 2，她写满 8000 字符的日记
    // 实际只能写一半 —— 上限是给人写的，就按人眼里的"字"来算。
    const chars = [...bodyText].length;
    if (chars > MAX_DIARY_CHARS) {
      fail(
        "DIARY_TOO_LONG",
        `这篇日记 ${chars} 字，超过 ${MAX_DIARY_CHARS} 字上限 ${chars - MAX_DIARY_CHARS} 字`,
      );
    }
    if (!bodyText && !moodText) {
      fail("DIARY_EMPTY", "正文和心情都是空的 —— 空的这一篇不值得写进日记");
    }

    const created = now();
    return this.store.tx(() => {
      const old = this.store.db
        .prepare("SELECT id FROM diary WHERE kind=? AND date=?")
        .get(kind, date);
      if (old) {
        // 保留 id：同一天的这篇还是同一篇，只是内容改了。
        this.store.db
          .prepare("UPDATE diary SET mood=?, body=?, created=? WHERE id=?")
          .run(moodText, bodyText, created, old.id);
        return { id: old.id, kind, date, created, overwritten: true };
      }
      const id = randomUUID();
      this.store.db
        .prepare(
          "INSERT INTO diary(id, kind, date, mood, body, created) VALUES(?,?,?,?,?,?)",
        )
        .run(id, kind, date, moodText, bodyText, created);
      return { id, kind, date, created, overwritten: false };
    });
  }

  /** 读最近 n 天（每本每天最多一篇，所以条数 = 天数），按日期倒序 */
  recent(kind, n = 7) {
    book(kind);
    // 取整：设置页可能传 7.5 这种值，SQLite 的 LIMIT 只认整数，会报 datatype mismatch。
    const limit = Math.min(365, Math.max(1, Math.floor(Number(n) || 7)));
    return this.store.db
      .prepare(
        "SELECT date, kind, mood, body, created FROM diary WHERE kind=? ORDER BY date DESC, created DESC LIMIT ?",
      )
      .all(kind, limit)
      .map((r) => ({
        date: r.date,
        kind: r.kind,
        mood: r.mood,
        body: r.body,
        created: r.created,
      }));
  }

  /** 导出成 Markdown 本地文件，返回文件路径 */
  exportFile(kind) {
    const b = book(kind);
    // 按日期正序：日记是一页页往后翻的，翻到最新那篇在最后。
    const rows = this.store.db
      .prepare(
        "SELECT date, mood, body FROM diary WHERE kind=? ORDER BY date ASC, created ASC",
      )
      .all(kind);

    const parts = [`# ${b.title}\n`, `${b.intro}\n`];
    for (const row of rows) {
      const heading = row.mood ? `${row.date} · ${escape(row.mood)}` : row.date;
      // 只写了心情的那篇就只留标题 —— 不给她补正文，补出来的不是她的话。
      const text = row.body ? `\n\n${escape(row.body)}` : "";
      parts.push(`\n---\n\n## ${heading}${text}\n`);
    }

    const path = this.path(kind);
    // 自定义 dir 可能还不存在；导出是唯一写文件的地方，所以在这里建目录。
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // 原子写：先 .tmp 再 rename，设置页不会读到半篇日记。
    atomic(path, parts.join(""));
    return path;
  }

  /** 读导出文件的原始内容（给设置页展示）；还没导出过就是空 */
  readFile(kind) {
    const path = this.path(kind);
    if (!existsSync(path)) return { path, text: "", exists: false };
    return { path, text: readFileSync(path, "utf8"), exists: true };
  }

  path(kind) {
    return join(this.dir, book(kind).file);
  }
}
