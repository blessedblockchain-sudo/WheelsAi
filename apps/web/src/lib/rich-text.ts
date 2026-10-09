/**
 * The one formatter for a model's answer: text in, a small tree out.
 *
 * It knows headings, paragraphs, ordered and unordered lists, bold,
 * emphasis, inline code, code blocks and links that are http or https. Everything else stays
 * the plain text it was, markers included, so nothing a model writes can
 * turn into markup: there is no HTML node in the tree at all. Text that is
 * a JSON object or array becomes one pretty-printed code block.
 *
 * Pure and dependency-free; `components/ui/result-view.tsx` draws the tree.
 * Every scan is bounded, so the work grows in step with the input.
 */

export type RichInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  /** `children` are text, code, links and emphasis; never another bold. */
  | { type: "bold"; children: RichInline[] }
  /** `*words*` or `_words_`. `children` are text, code and links. */
  | { type: "em"; children: RichInline[] }
  /** `href` is always an absolute http or https address. `text` is drawn as plain text. */
  | { type: "link"; href: string; text: string };

export type RichBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: RichInline[] }
  | { type: "paragraph"; children: RichInline[] }
  /** `start` is the first number of an ordered list. Items do not nest. */
  | { type: "list"; ordered: boolean; start: number; items: RichInline[][] }
  /** `lang` is "json" for pretty-printed JSON, or the word after the opening fence. */
  | { type: "code"; text: string; lang: string | null };

/** Above this many characters an answer is shown as plain text, unparsed. */
export const MAX_RICH_CHARS = 200_000;

/** The longest link label and link address looked for, in characters. */
const MAX_LABEL = 500;
const MAX_HREF = 2000;

/**
 * The address when it is safe to put in an `href`, else null. Only absolute
 * http and https addresses pass: `javascript:`, `data:`, relative paths and
 * anything with a space or a control character do not.
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href.length === 0 || href.length > MAX_HREF) return null;
  if (!/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
  } catch {
    return null;
  }
  return href;
}

/** Pretty-printed JSON when the whole text is a JSON object or array, else null. */
export function prettyJsonOf(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

const BARE_URL = /https?:\/\/[^\s<>"`]{1,2000}/iy;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** Sentence punctuation after a pasted address is not part of it. */
function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1] ?? "";
    if (".,;:!?'*".includes(ch)) end--;
    else if (ch === ")" && !url.slice(0, end).includes("(")) end--;
    else if (ch === "]" && !url.slice(0, end).includes("[")) end--;
    else break;
  }
  return url.slice(0, end);
}

/**
 * Emphasis, `*words*` or `_words_`: whether a marker opens it, and where it
 * closes (or -1).
 *
 * An opening marker stands at the start of a word: nothing word-like before
 * it (so `snake_case` and `2*3` open nothing) and no space after it (so
 * `2 * 3 * 4` and a list's `* ` open nothing). A closing marker stands at
 * the end of one: no space before it and nothing word-like after it. Neither
 * is half of a `**`. The search stops at `limit`, the end of the paragraph.
 */
function emphasisOpens(src: string, open: number, marker: "*" | "_"): boolean {
  const after = src[open + 1];
  if (after === undefined || after === marker || /\s/.test(after)) return false;
  return !isWordChar(src[open - 1]) && src[open - 1] !== marker;
}

function emphasisClose(src: string, open: number, marker: "*" | "_", limit: number): number {
  for (let at = src.indexOf(marker, open + 2); at !== -1 && at < limit; at = src.indexOf(marker, at + 1)) {
    const before = src[at - 1] ?? " ";
    if (/\s/.test(before) || before === marker) continue;
    if (src[at + 1] === marker || isWordChar(src[at + 1])) continue;
    return at;
  }
  return -1;
}

/** Bold, emphasis, inline code and links inside one block of text. */
export function parseInline(src: string, allowBold = true, allowEm = true): RichInline[] {
  const out: RichInline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push({ type: "text", text: plain });
      plain = "";
    }
  };
  // Once a closing marker is known to be absent, it is not looked for again.
  let noBacktick = false;
  let noBoldClose = false;
  // Emphasis: no closing marker before this place, so none is looked for until it.
  const noEmUntil = { "*": 0, _: 0 };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "`" && !noBacktick) {
      const close = src.indexOf("`", i + 1);
      if (close === -1) noBacktick = true;
      else if (close > i + 1 && !src.slice(i + 1, close).includes("\n\n")) {
        flush();
        out.push({ type: "code", text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (allowBold && ch === "*" && src[i + 1] === "*" && !noBoldClose) {
      const close = src.indexOf("**", i + 2);
      if (close === -1) noBoldClose = true;
      else {
        const inner = src.slice(i + 2, close);
        if (inner.length > 0 && inner.trim() === inner && !inner.includes("\n\n")) {
          flush();
          out.push({ type: "bold", children: parseInline(inner, false, allowEm) });
          i = close + 2;
          continue;
        }
      }
    }

    if (allowEm && (ch === "*" || ch === "_")) {
      if (i >= noEmUntil[ch] && emphasisOpens(src, i, ch)) {
        const paragraphEnd = src.indexOf("\n\n", i);
        const limit = paragraphEnd === -1 ? src.length : paragraphEnd;
        const close = emphasisClose(src, i, ch, limit);
        if (close !== -1) {
          flush();
          out.push({ type: "em", children: parseInline(src.slice(i + 1, close), false, false) });
          i = close + 1;
          continue;
        }
        // No closing marker in this paragraph: none is looked for again before its end.
        noEmUntil[ch] = limit;
      }
      // A run of markers (`**`, `__`) is skipped whole, so its second half opens nothing.
      if (src[i + 1] === ch) {
        let end = i;
        while (src[end] === ch) end++;
        plain += src.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === "[") {
      const labelEnd = src.slice(i + 1, i + 1 + MAX_LABEL + 1).indexOf("]");
      if (labelEnd > 0) {
        const close = i + 1 + labelEnd;
        if (src[close + 1] === "(") {
          const hrefEnd = src.slice(close + 2, close + 2 + MAX_HREF + 1).indexOf(")");
          if (hrefEnd > 0) {
            const label = src.slice(i + 1, close);
            const href = safeHref(src.slice(close + 2, close + 2 + hrefEnd));
            if (href && !label.includes("\n") && label.trim().length > 0) {
              flush();
              out.push({ type: "link", href, text: label });
              i = close + 2 + hrefEnd + 1;
              continue;
            }
          }
        }
      }
    }

    if ((ch === "h" || ch === "H") && !isWordChar(src[i - 1])) {
      BARE_URL.lastIndex = i;
      const match = BARE_URL.exec(src);
      if (match) {
        const raw = trimUrlTail(match[0]);
        const href = safeHref(raw);
        if (href) {
          flush();
          out.push({ type: "link", href, text: raw });
          i += raw.length;
          continue;
        }
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** Leading spaces, a tab counting as four. */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** The fence that opens or closes a code block, with the word after it. */
function fenceOf(line: string): { marker: string; info: string } | null {
  if (indentOf(line) > 3) return null;
  const body = line.trimStart();
  const ch = body[0];
  if (ch !== "`" && ch !== "~") return null;
  let n = 0;
  while (body[n] === ch) n++;
  if (n < 3) return null;
  const info = body.slice(n).trim();
  if (ch === "`" && info.includes("`")) return null;
  return { marker: ch.repeat(n), info };
}

function headingOf(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  if (indentOf(line) > 3) return null;
  const body = line.trimStart();
  let n = 0;
  while (body[n] === "#") n++;
  if (n < 1 || n > 6) return null;
  if (body[n] !== " " && body[n] !== "\t") return null;
  const text = body.slice(n + 1).trim();
  if (!text) return null;
  return { level: n as 1 | 2 | 3 | 4 | 5 | 6, text };
}

function listItemOf(line: string): { ordered: boolean; start: number; text: string } | null {
  const body = line.trimStart();
  if ("-*+•".includes(body[0] ?? "\n") && (body[1] === " " || body[1] === "\t")) {
    const text = body.slice(2).trim();
    return text ? { ordered: false, start: 1, text } : null;
  }
  let n = 0;
  while (n < 9 && /[0-9]/.test(body[n] ?? "")) n++;
  if (n > 0 && (body[n] === "." || body[n] === ")") && (body[n + 1] === " " || body[n + 1] === "\t")) {
    const text = body.slice(n + 2).trim();
    return text ? { ordered: true, start: Number(body.slice(0, n)), text } : null;
  }
  return null;
}

interface OpenList {
  ordered: boolean;
  start: number;
  /** Indent of the list's own markers; deeper lines belong to the item above. */
  indent: number;
  items: string[];
}

/**
 * An answer as blocks. Never throws: text that is not one of the known
 * constructs comes back as a paragraph of plain text.
 */
export function parseRichText(input: string): RichBlock[] {
  if (typeof input !== "string" || input.trim().length === 0) return [];

  const json = prettyJsonOf(input);
  if (json !== null) return [{ type: "code", text: json, lang: "json" }];

  const text = input.replace(/\r\n?/g, "\n");
  if (text.length > MAX_RICH_CHARS) {
    return [{ type: "paragraph", children: [{ type: "text", text }] }];
  }

  const blocks: RichBlock[] = [];
  let para: string[] = [];
  let list: OpenList | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        start: list.start,
        items: list.items.map((item) => parseInline(item)),
      });
      list = null;
    }
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fence = fenceOf(line);
    if (fence) {
      flushPara();
      flushList();
      const body: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        const inner = lines[i] ?? "";
        const close = fenceOf(inner);
        if (close && close.info === "" && close.marker[0] === fence.marker[0] && close.marker.length >= fence.marker.length) break;
        body.push(inner);
      }
      // A fence left open (an answer still streaming, or cut short) runs to the end.
      blocks.push({ type: "code", text: body.join("\n"), lang: fence.info.split(/\s+/)[0] || null });
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      continue;
    }

    const indent = indentOf(line);
    const open = list as OpenList | null;

    // A deeper line under a list item is part of that item, as text: a list
    // inside a list is not a construct here, so its markers stay visible.
    if (open && indent >= open.indent + 2) {
      open.items[open.items.length - 1] += "\n" + line.slice(Math.min(line.length - line.trimStart().length, open.indent + 2)).trimEnd();
      continue;
    }

    const item: ReturnType<typeof listItemOf> = indent <= 3 || open ? listItemOf(line) : null;
    if (item) {
      flushPara();
      if (open && open.ordered === item.ordered) {
        open.items.push(item.text);
      } else {
        flushList();
        list = { ordered: item.ordered, start: item.start, indent, items: [item.text] };
      }
      continue;
    }

    flushList();

    const heading = headingOf(line);
    if (heading) {
      flushPara();
      blocks.push({ type: "heading", level: heading.level, children: parseInline(heading.text) });
      continue;
    }

    para.push(line.trimEnd());
  }
  flushPara();
  flushList();
  return blocks;
}

/** The words of a tree with every marker gone; for tests and for plain previews. */
export function plainTextOf(blocks: RichBlock[]): string {
  const inline = (nodes: RichInline[]): string =>
    nodes.map((node) => (node.type === "bold" || node.type === "em" ? inline(node.children) : node.text)).join("");
  return blocks
    .map((block) => {
      if (block.type === "code") return block.text;
      if (block.type === "list") return block.items.map(inline).join("\n");
      return inline(block.children);
    })
    .join("\n");
}
