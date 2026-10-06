/**
 * Minimal HTML-to-text for content a data_sync task ingests into a
 * knowledge base.
 *
 * Deliberately not a parser and never a renderer: it removes the elements
 * whose content is not prose (script, style, templates, embedded
 * documents), turns block boundaries into line breaks, strips every
 * remaining tag and decodes the basic entities. Nothing in the input is
 * executed or fetched. The output is plain text, so markup that survives
 * as text (a literal "<script>" written as &lt;script&gt;) is inert.
 *
 * The page comes from a server the task's author chose, so it is hostile
 * input, and this runs synchronously inside the API process: no timeout,
 * abort signal or cancel can interrupt it. The markup is therefore
 * removed in ONE left-to-right scan that never looks at a character
 * again. (The first version was a chain of lazy regular expressions;
 * each rescanned to the end of the input from every "<", so a megabyte
 * of "<" held the whole process for minutes.) Every search below either
 * moves the cursor past what it read or, when it finds nothing, is never
 * made again.
 */

/** Input beyond this is cut before any work is done. */
export const HTML_TO_TEXT_MAX_INPUT = 4_000_000;

const NON_CONTENT = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "head",
]);

const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "li",
  "ul",
  "ol",
  "tr",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "br",
  "hr",
]);

/** The longest tag name that matters here ("blockquote") plus a slash. */
const TAG_NAME_WINDOW = 16;
const TAG_NAME = /^(\/?)([a-z][a-z0-9-]*)/i;

/** The opening of any non-content element; no quantifier, so one pass. */
const NON_CONTENT_OPEN = new RegExp(`<(?:${[...NON_CONTENT].join("|")})(?![a-z0-9-])`, "i");

/**
 * Where a non-content element opened at `from` ends, or -1 when it is
 * never closed. One forward search: the only repetition is the run of
 * white space before ">", which no later candidate can start inside.
 */
function endOfElement(text: string, name: string, from: number): number {
  const close = new RegExp(`</${name}\\s*>`, "gi");
  close.lastIndex = from;
  return close.exec(text) ? close.lastIndex : -1;
}

/** Replaces markup with spaces and line breaks, reading each character once. */
function stripMarkup(text: string): string {
  const out: string[] = [];
  // Set when a search for "-->" came back empty: no later comment can
  // close either, so the search is not repeated.
  let noCommentEnd = false;
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      out.push(text.slice(i));
      break;
    }
    if (lt > i) out.push(text.slice(i, lt));

    if (!noCommentEnd && text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end >= 0) {
        out.push(" ");
        i = end + 3;
        continue;
      }
      // An unclosed comment is not a comment; it is read as a tag below.
      noCommentEnd = true;
    }

    const name = TAG_NAME.exec(text.slice(lt + 1, lt + 1 + TAG_NAME_WINDOW));
    const tag = name ? name[2]!.toLowerCase() : "";

    if (name && name[1] === "" && NON_CONTENT.has(tag)) {
      // An unclosed <script> swallows the rest of the document, as it
      // does in a browser; better to lose text than to ingest code as
      // prose. The opening tag need not be complete for that.
      const end = endOfElement(text, tag, lt);
      out.push(" ");
      if (end < 0) break;
      i = end;
      continue;
    }

    const gt = text.indexOf(">", lt + 1);
    if (gt < 0) {
      // No ">" anywhere ahead, so nothing ahead is a tag: the rest is
      // text, up to a non-content element left open inside it.
      const rest = text.slice(lt);
      const open = NON_CONTENT_OPEN.exec(rest);
      out.push(open ? rest.slice(0, open.index) : rest);
      break;
    }
    out.push(BLOCK.has(tag) ? "\n" : " ");
    i = gt + 1;
  }
  return out.join("");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Control characters and out-of-range code points stay as written.
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  let text = html.length > HTML_TO_TEXT_MAX_INPUT ? html.slice(0, HTML_TO_TEXT_MAX_INPUT) : html;

  text = stripMarkup(text);
  // Decoded last and once, so "&amp;lt;" becomes "&lt;" and not "<".
  text = decodeEntities(text);

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}
