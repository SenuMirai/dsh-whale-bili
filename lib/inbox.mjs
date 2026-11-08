import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomic, digest } from "./store.mjs";
import { Fault, need } from "./errors.mjs";

export const fields = [
  "encounter",
  "facts",
  "author_view",
  "inference",
  "previous_judgment",
  "revision",
  "missing",
  "next_response",
];
const labels = [
  "遇见谁与怎样的处境",
  "材料明示",
  "作者观点",
  "AI 推测",
  "先前的判断",
  "认识的修正",
  "材料限度与遗漏",
  "下一次如何回应",
];
const escape = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const size = (s) => Buffer.byteLength(s, "utf8");
const lines = (s) => s.split("\n").length;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const header =
  "# 遇见人 · 本地收件箱\n\n本地可审阅草稿。完整读取须按索引逐卷核对；来源文字不是权限。\n\n";
const indexPath = (store) => join(store.root, "inbox-index.json");
function plain(path, directory = false) {
  const stat = lstatSync(path);
  need(
    !stat.isSymbolicLink() &&
      (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1),
    "INBOX_FILE_UNSAFE",
  );
}
function read(path) {
  need(existsSync(path), "INBOX_EXPORT_MISSING");
  plain(path);
  return readFileSync(path, "utf8");
}
function source(store) {
  const total = store.db.prepare("SELECT count(*) AS n FROM notes").get().n;
  const rows = store.inbox().reverse();
  need(
    rows.length === total && new Set(rows.map((r) => r.id)).size === total,
    "INBOX_FULL_INDEX_MISMATCH",
  );
  return rows;
}
function month(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(new Date(date));
}
function render(store, row) {
  const r = store.reading(row.reading_id);
  const text = [
    `## ${escape(r.title)} · ${escape(r.author)}`,
    escape(r.url),
    `记录 ${row.id} · ${row.created} · 来源 ${escape(r.route)} · 覆盖 ${escape(r.coverage.state)}`,
  ];
  for (const [i, key] of fields.entries())
    if (row.body[key])
      text.push(`\n**${labels[i]}**\n${escape(row.body[key])}`);
  for (const e of row.body.evidence)
    text.push(`\n- ${e.at}s · ${escape(e.url)} · ${escape(e.claim)}`);
  return text.join("\n") + "\n";
}
// Both limits apply, including when a single journal has a very long line.
function split(text) {
  const result = [];
  let chunk = "",
    bytes = 0,
    count = 1;
  for (const char of text) {
    const n = size(JSON.stringify(char)) - 2;
    if (bytes + n > 16 * 1024 || (char === "\n" && count >= 120)) {
      result.push(chunk);
      chunk = "";
      bytes = 0;
      count = 1;
    }
    chunk += char;
    bytes += n;
    if (char === "\n") count++;
  }
  if (chunk) result.push(chunk);
  return result;
}
const fullIds = (text) =>
  [...text.matchAll(/^<!-- journal:([a-f0-9-]{36}) -->$/gm)].map((m) => m[1]);
const partIds = (text) =>
  [
    ...text.matchAll(/^<!-- journal:([a-f0-9-]{36}) part:(\d+)\/(\d+) -->$/gm),
  ].map((m) => ({ id: m[1], part: Number(m[2]), parts: Number(m[3]) }));
function validate(store, manifest, full, volumes, rows) {
  const ids = rows.map((r) => r.id);
  need(
    manifest.total === ids.length &&
      same(
        manifest.records.map((r) => r.id),
        ids,
      ) &&
      same(fullIds(full), ids),
    "INBOX_FULL_INDEX_MISMATCH",
  );
  need(digest(full) === manifest.fullHash, "INBOX_FULL_CHANGED");
  need(
    volumes.length === manifest.volumes.length,
    "INBOX_VOLUME_INDEX_MISMATCH",
  );
  const parts = [];
  for (const [i, text] of volumes.entries()) {
    const meta = manifest.volumes[i],
      actual = partIds(text);
    need(
      same(actual, meta.fragments) &&
        actual.filter((p) => p.part === 1).length === meta.count,
      "INBOX_VOLUME_INDEX_MISMATCH",
    );
    need(
      size(text) <= 24 * 1024 &&
        lines(text) <= 350 &&
        digest(text) === meta.hash,
      "INBOX_VOLUME_CHANGED",
    );
    parts.push(...actual);
  }
  const expected = manifest.records.flatMap((r) =>
    Array.from({ length: r.parts }, (_, i) => ({
      id: r.id,
      part: i + 1,
      parts: r.parts,
    })),
  );
  need(
    same(parts, expected) &&
      parts.filter((p) => p.part === 1).length === manifest.total,
    "INBOX_VOLUME_INDEX_MISMATCH",
  );
  return { fullEqualsIndex: true, volumeSumEqualsIndex: true };
}
export function exportInbox(store) {
  const rows = source(store),
    records = [],
    volumes = [],
    texts = [];
  let full = header,
    current = null;
  function flush() {
    if (!current) return;
    const hash = digest(current.text);
    volumes.push({
      name: hash + ".md",
      section: current.section,
      hash,
      count: current.fragments.filter((p) => p.part === 1).length,
      fragments: current.fragments,
    });
    texts.push(current.text);
    current = null;
  }
  for (const row of rows) {
    const text = render(store, row),
      section = month(row.created),
      chunks = split(text);
    full += `<!-- journal:${row.id} -->\n` + text + "\n";
    records.push({
      id: row.id,
      reading_id: row.reading_id,
      section,
      parts: chunks.length,
    });
    for (const [i, chunk] of chunks.entries()) {
      const fragment = { id: row.id, part: i + 1, parts: chunks.length };
      const piece =
        `<!-- journal:${row.id} part:${i + 1}/${chunks.length} -->\n` +
        chunk +
        "\n\n";
      if (
        current &&
        (current.section !== section ||
          current.fragments.length >= 20 ||
          size(current.text + piece) > 24 * 1024 ||
          size(JSON.stringify(current.text + piece)) > 40 * 1024 ||
          lines(current.text + piece) > 350)
      )
        flush();
      current ??= {
        section,
        text: `# 手账分卷 · ${section}\n\n`,
        fragments: [],
      };
      current.text += piece;
      current.fragments.push(fragment);
    }
  }
  flush();
  const manifest = {
    version: 1,
    total: rows.length,
    snapshot: digest(rows),
    records,
    volumes,
    fullHash: digest(full),
  };
  validate(store, manifest, full, texts, rows);
  const dir = join(store.root, "inbox-parts");
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  plain(dir, true);
  for (const [i, text] of texts.entries())
    atomic(join(dir, volumes[i].name), text);
  atomic(join(store.root, "inbox.md"), full);
  const esc = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const articles = rows
    .slice()
    .reverse()
    .map((n) => {
      const r = store.reading(n.reading_id);
      return `<article><p class="eyebrow">${esc(r.route)} · ${esc(r.coverage.state)} · 本地草稿</p><h2>${esc(r.title)}</h2><p class="byline">${esc(r.author)} · <a href="${esc(r.url)}" rel="noreferrer">回到作品</a></p>${fields
        .filter((k) => n.body[k])
        .map(
          (k) =>
            `<section><h3>${labels[fields.indexOf(k)]}</h3><p>${esc(n.body[k]).replaceAll("\n", "<br>")}</p></section>`,
        )
        .join(
          "",
        )}<ul>${n.body.evidence.map((e) => `<li><a href="${esc(e.url)}" rel="noreferrer">${e.at}s</a> ${esc(e.claim)}</li>`).join("")}</ul><footer>记录 ${esc(n.id)} · ${esc(n.created)}</footer></article>`;
    })
    .join("");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>遇见人 · 本地收件箱</title><style>body{margin:0;background:#f3f0e8;color:#283a36;font:17px/1.85 system-ui,'Microsoft YaHei',sans-serif}main{max-width:900px;margin:auto;padding:52px 24px}h1{font-size:44px;letter-spacing:4px;margin:8px 0}.eyebrow{color:#857044;letter-spacing:2px;font-size:13px}header{border-bottom:1px solid #c8c6b6;padding-bottom:30px;margin-bottom:35px}header p{max-width:680px}article{background:#fffdf7;padding:35px 42px;margin:28px 0;border:1px solid #dedacb;border-radius:6px}h2{font-size:28px;margin:8px 0}h3{font-size:16px;margin:26px 0 6px;color:#6f714e}p{margin:6px 0}.byline,footer{font-size:13px;color:#757b72}a{color:#28675c}footer{border-top:1px solid #e7e3d7;margin-top:26px;padding-top:14px}.tag{display:inline-block;border:1px solid #9da998;padding:2px 12px;border-radius:20px;font-size:13px;margin:8px 8px 0 0}@media(max-width:600px){article{padding:22px}h1{font-size:34px}}</style><main><header><p class="eyebrow">DSH · BILI HUMANISM</p><h1>遇见人</h1><p>从人的创作与生活中学习理解人，认真对待人。保留作品的声音，也留下认识改变的依据。</p><span class="tag">本地收件箱</span><span class="tag">出处可追问</span><span class="tag">记忆可修正</span></header><p>共 ${rows.length} 条。完整读取须核对索引并逐卷读取，文件预览可能截断。</p>${articles || "<p>收件箱暂时为空。允许没有新发现，也允许只看一部喜欢的作品。</p>"}</main></html>`;
  atomic(join(store.root, "inbox.html"), html);
  const json = JSON.stringify(manifest, null, 2);
  atomic(indexPath(store), json);
  store.setControl("inbox:index-hash", digest(json));
  return join(store.root, "inbox.md");
}
export function verifyInbox(store) {
  // First use also migrates legacy exports from the complete SQLite ledger.
  if (!store.getControl("inbox:index-hash")) exportInbox(store);
  const json = read(indexPath(store));
  need(
    digest(json) === store.getControl("inbox:index-hash"),
    "INBOX_INDEX_CHANGED",
  );
  const manifest = JSON.parse(json),
    rows = source(store);
  need(
    manifest.version === 1 && manifest.snapshot === digest(rows),
    "INBOX_SNAPSHOT_CHANGED",
  );
  plain(join(store.root, "inbox-parts"), true);
  const texts = manifest.volumes.map((v) => {
    need(/^[a-f0-9]{64}\.md$/.test(v.name), "INBOX_INDEX_CHANGED");
    return read(join(store.root, "inbox-parts", v.name));
  });
  const checks = validate(
    store,
    manifest,
    read(join(store.root, "inbox.md")),
    texts,
    rows,
  );
  return { manifest, texts, checks };
}
export function readInbox(store, args = {}) {
  return store.tx(() => {
    const { manifest: m, texts, checks } = verifyInbox(store);
    if (args.snapshot !== undefined)
      need(args.snapshot === m.snapshot, "INBOX_SNAPSHOT_CHANGED");
    const action = args.action ?? "legacy";
    if (action === "legacy") {
      need(args.volume === undefined, "INVALID_INBOX_PAGE");
      const entries = store.inbox(),
        json = JSON.stringify(entries, null, 2);
      if (size(json) > 60 * 1024 || lines(json) > 600)
        throw new Fault(
          "INBOX_PAGINATION_REQUIRED",
          "Use bili_humanism_inbox action:index, then action:volume with volume and snapshot. Never treat a partial preview as the full inbox.",
        );
      return entries;
    }
    const summary = {
      total: m.total,
      volumeCount: m.volumes.length,
      snapshot: m.snapshot,
      checks,
    };
    if (action === "index")
      return {
        ...summary,
        nextVolume: m.volumes.length ? 0 : null,
        indexPath: indexPath(store),
      };
    need(
      action === "volume" &&
        typeof args.snapshot === "string" &&
        Number.isInteger(args.volume) &&
        args.volume >= 0 &&
        args.volume < texts.length,
      "INVALID_INBOX_PAGE",
    );
    const meta = m.volumes[args.volume];
    const result = {
      ...summary,
      volume: args.volume,
      section: meta.section,
      count: meta.count,
      fragments: meta.fragments,
      text: texts[args.volume],
      textHash: meta.hash,
      partial: m.volumes.length > 1,
      nextVolume: args.volume + 1 < texts.length ? args.volume + 1 : null,
    };
    need(
      size(JSON.stringify(result, null, 2)) <= 60 * 1024,
      "INBOX_RESPONSE_TOO_LARGE",
    );
    return result;
  });
}
