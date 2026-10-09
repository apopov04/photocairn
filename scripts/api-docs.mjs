// Builds the developer docs from one source:
//   scripts/docs-guide.md  (hand-written guide: tools, shortcuts, examples)
//   js/api-spec.js         (the API: methods, parameters, defaults)
// into
//   llms-full.txt            (Markdown, for LLMs)
//   developers/index.html    (the same content as a plain HTML page)
//
//   node scripts/api-docs.mjs          write both files
//   node scripts/api-docs.mjs --check  exit 1 if they're out of date (used by npm test)

import fs from "node:fs";
import { METHODS, signature, API_VERSION } from "../js/api-spec.js";

const root = new URL("../", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");

/* ------------------------------ API reference ------------------------------ */

function typeText(p) {
  let t = p.type === "enum" ? p.values.map((v) => (typeof v === "string" ? `"${v}"` : v)).join(" \\| ") : p.type;
  if (p.type === "color") t = p.transparent ? `color \\| "transparent"${p.extra ? ` \\| ${p.extra.map((x) => `"${x}"`).join(" \\| ")}` : ""}` : "color";
  if (p.min !== undefined && p.max !== undefined) t += `, ${p.min}..${p.max}`;
  else if (p.min !== undefined) t += `, ≥ ${p.min}`;
  else if (p.max !== undefined) t += `, ≤ ${p.max}`;
  return t;
}
const defText = (p) => (p.required ? "required" : p.default !== undefined ? `\`${JSON.stringify(p.default)}\`` : p.defaultText || "");

/** The API reference as Markdown (one section per group). */
export function apiMarkdown() {
  const out = [];
  let group = null;
  for (const m of METHODS) {
    if (m.group !== group) { group = m.group; out.push(`### ${group}`, ""); }
    out.push(`#### \`${signature(m)}\``, "", m.desc, "");
    if (m.params.length) {
      out.push("| Option | Type | Default | Description |", "| --- | --- | --- | --- |");
      for (const p of m.params) out.push(`| \`${p.name}\` | ${typeText(p)} | ${defText(p)} | ${p.desc.replace(/\|/g, "\\|")} |`);
      out.push("");
    }
    out.push(`Returns: ${m.returns.replace(/\.$/, "")}.${m.history ? ` History: "${m.history}".` : ""}`, "", "```js", m.example, "```", "");
  }
  return out.join("\n");
}

/** llms-full.txt: the guide with the reference filled in. */
export function fullText() {
  return read("scripts/docs-guide.md").replace("{{API_REFERENCE}}", apiMarkdown().trim()).replace(/\{\{API_VERSION\}\}/g, String(API_VERSION));
}

/* --------------------------- tiny Markdown to HTML --------------------------- */

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s).replace(/\\\|/g, "|");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href.replace(/^https:\/\/photocairn\.silicairn\.com\//, "../")}">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i]).replace(/\\\|/g, "|")}</code>`);
}

const cells = (row) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());

/** Enough Markdown for the guide: headings, paragraphs, lists, code, tables, quotes. Returns { html, toc }. */
export function markdownToHtml(md) {
  const lines = md.split("\n"), html = [], toc = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      html.push(`<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const hd = /^(#{1,4}) (.*)$/.exec(line);
    if (hd) {
      const n = hd[1].length, text = inline(hd[2]), id = /^<code>(\w+)\(/.exec(text)?.[1] || slug(text); // methods: #crop
      if (n === 2) toc.push({ id, text });
      html.push(`<h${n} id="${id}">${text}</h${n}>`);
      i++; continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i]);
      const [head, , ...body] = rows;
      html.push(`<div class="table"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (line.startsWith("> ")) {
      const body = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) body.push(lines[i].replace(/^> ?/, ""));
      html.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      for (; i < lines.length && /^\d+\. /.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\d+\. /, ""))}</li>`);
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (/^\s*- /.test(line)) {
      // Lists: "- item", nested with two spaces; continuation lines are indented.
      const stack = [];
      let out = "";
      for (; i < lines.length && (/^\s*- /.test(lines[i]) || (/^\s+\S/.test(lines[i]) && stack.length)); i++) {
        const m = /^(\s*)- (.*)$/.exec(lines[i]);
        if (!m) { out += " " + inline(lines[i].trim()); continue; }
        const depth = m[1].length / 2;
        while (stack.length > depth + 1) { out += "</li></ul>"; stack.pop(); }
        if (stack.length === depth + 1) out += "</li>";
        else if (stack.length < depth + 1) { out += "<ul>"; stack.push(depth); }
        out += `<li>${inline(m[2])}`;
      }
      while (stack.length) { out += "</li></ul>"; stack.pop(); }
      html.push(out);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4} |```|\||> |\s*- |\d+\. )/.test(lines[i]); i++) para.push(lines[i].trim());
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { html: html.join("\n"), toc };
}

/** developers/index.html */
export function pageHtml() {
  const md = fullText().replace(/^# .*\n/, ""); // the page has its own title
  const { html, toc } = markdownToHtml(md);
  const nav = toc.map((t) => `<a href="#${t.id}">${t.text}</a>`).join("\n      ");
  return read("scripts/docs-page.html")
    .replace("{{NAV}}", nav)
    .replace("{{CONTENT}}", html);
}

/* ---------------------------------- main ---------------------------------- */

const outputs = { "llms-full.txt": fullText, "developers/index.html": pageHtml };

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, make] of Object.entries(outputs)) {
    const url = new URL(file, root), want = make();
    const have = fs.existsSync(url) ? fs.readFileSync(url, "utf8") : null;
    if (have === want) continue;
    if (check) { console.error(`${file} is out of date: run npm run docs`); stale++; }
    else { fs.mkdirSync(new URL(".", url), { recursive: true }); fs.writeFileSync(url, want); console.log(`wrote ${file}`); }
  }
  process.exit(stale ? 1 : 0);
}

export { outputs };
