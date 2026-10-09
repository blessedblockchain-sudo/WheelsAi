/**
 * The result formatter: each construct, and what must stay plain text. Run with:
 *   cd apps/web && npx tsx --test src/lib/rich-text.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_RICH_CHARS,
  parseInline,
  parseRichText,
  plainTextOf,
  prettyJsonOf,
  safeHref,
  type RichBlock,
  type RichInline,
} from "./rich-text";

const text = (value: string): RichInline => ({ type: "text", text: value });

/** Every link address anywhere in a tree. */
function hrefsOf(blocks: RichBlock[]): string[] {
  const walk = (nodes: RichInline[]): string[] =>
    nodes.flatMap((node) => (node.type === "link" ? [node.href] : node.type === "bold" ? walk(node.children) : []));
  return blocks.flatMap((block) => {
    if (block.type === "code") return [];
    if (block.type === "list") return block.items.flatMap(walk);
    return walk(block.children);
  });
}

test("empty and blank text give no blocks", () => {
  assert.deepEqual(parseRichText(""), []);
  assert.deepEqual(parseRichText("  \n\n  "), []);
  assert.deepEqual(parseRichText(undefined as unknown as string), []);
});

test("headings carry their level", () => {
  assert.deepEqual(parseRichText("# Title\n### Smaller"), [
    { type: "heading", level: 1, children: [text("Title")] },
    { type: "heading", level: 3, children: [text("Smaller")] },
  ]);
  // No space after the marks, or more than six of them: not a heading.
  assert.deepEqual(parseRichText("#hashtag"), [{ type: "paragraph", children: [text("#hashtag")] }]);
  assert.deepEqual(parseRichText("####### seven"), [{ type: "paragraph", children: [text("####### seven")] }]);
});

test("paragraphs are split by blank lines and keep their line breaks", () => {
  assert.deepEqual(parseRichText("one\ntwo\n\nthree"), [
    { type: "paragraph", children: [text("one\ntwo")] },
    { type: "paragraph", children: [text("three")] },
  ]);
  assert.deepEqual(parseRichText("a\r\nb"), [{ type: "paragraph", children: [text("a\nb")] }]);
});

test("unordered lists, with any of the usual markers", () => {
  assert.deepEqual(parseRichText("- one\n* two\n+ three"), [
    { type: "list", ordered: false, start: 1, items: [[text("one")], [text("two")], [text("three")]] },
  ]);
});

test("ordered lists keep their first number and survive blank lines between items", () => {
  assert.deepEqual(parseRichText("3. three\n\n4. four\n5) five"), [
    { type: "list", ordered: true, start: 3, items: [[text("three")], [text("four")], [text("five")]] },
  ]);
});

test("a list ends at the next plain line, and a change of kind starts a new list", () => {
  const blocks = parseRichText("Steps:\n1. a\n2. b\n- c\nDone.");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "list", "list", "paragraph"],
  );
  assert.equal((blocks[1] as { ordered: boolean }).ordered, true);
  assert.equal((blocks[2] as { ordered: boolean }).ordered, false);
});

test("a list whose markers are all indented is still one list", () => {
  assert.deepEqual(parseRichText("  - one\n  - two"), [
    { type: "list", ordered: false, start: 1, items: [[text("one")], [text("two")]] },
  ]);
});

test("bold, inline code and links inside a line", () => {
  assert.deepEqual(parseInline("a **b** `c` [d](https://example.com/x) e"), [
    text("a "),
    { type: "bold", children: [text("b")] },
    text(" "),
    { type: "code", text: "c" },
    text(" "),
    { type: "link", href: "https://example.com/x", text: "d" },
    text(" e"),
  ]);
});

test("bold can hold code and a link; inline code holds only text", () => {
  assert.deepEqual(parseInline("**see `x` at https://a.io**"), [
    {
      type: "bold",
      children: [text("see "), { type: "code", text: "x" }, text(" at "), { type: "link", href: "https://a.io", text: "https://a.io" }],
    },
  ]);
  assert.deepEqual(parseInline("`**not bold** [x](https://a.io)`"), [{ type: "code", text: "**not bold** [x](https://a.io)" }]);
});

test("a pasted address is a link, without the sentence's punctuation", () => {
  assert.deepEqual(parseInline("See https://example.com/a?b=1."), [
    text("See "),
    { type: "link", href: "https://example.com/a?b=1", text: "https://example.com/a?b=1" },
    text("."),
  ]);
  assert.deepEqual(parseInline("(http://example.com/x)"), [
    text("("),
    { type: "link", href: "http://example.com/x", text: "http://example.com/x" },
    text(")"),
  ]);
  // Brackets that belong to the address stay in it.
  assert.equal(
    (parseInline("https://en.wikipedia.org/wiki/Rust_(language)")[0] as { href: string }).href,
    "https://en.wikipedia.org/wiki/Rust_(language)",
  );
});

test("code blocks keep their text exactly, and nothing inside is parsed", () => {
  const src = "Before\n```ts\nconst a = **1**;\n# not a heading\n- not a list\n```\nAfter";
  assert.deepEqual(parseRichText(src), [
    { type: "paragraph", children: [text("Before")] },
    { type: "code", lang: "ts", text: "const a = **1**;\n# not a heading\n- not a list" },
    { type: "paragraph", children: [text("After")] },
  ]);
});

test("a code block left open runs to the end", () => {
  assert.deepEqual(parseRichText("```\nstill streaming\nmore"), [{ type: "code", lang: null, text: "still streaming\nmore" }]);
});

test("JSON shows pretty-printed in one code block", () => {
  assert.deepEqual(parseRichText('{"a":1,"b":[true,null]}'), [
    { type: "code", lang: "json", text: '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}' },
  ]);
  assert.deepEqual(parseRichText(' [1,2] \n'), [{ type: "code", lang: "json", text: "[\n  1,\n  2\n]" }]);
  // A bare number or word, or broken JSON, is ordinary text.
  assert.equal(prettyJsonOf("42"), null);
  assert.equal(prettyJsonOf('"hello"'), null);
  assert.equal(prettyJsonOf("{not json}"), null);
  assert.equal(parseRichText("{not json}")[0]?.type, "paragraph");
});

test("nesting that is not supported falls back to text", () => {
  // A list inside a list: the inner lines stay text of the item above, markers and all.
  assert.deepEqual(parseRichText("- parent\n  - child\n    1. deeper\n- next"), [
    {
      type: "list",
      ordered: false,
      start: 1,
      items: [[text("parent\n- child\n  1. deeper")], [text("next")]],
    },
  ]);
  // Bold inside a link's words: the link is kept, the stars stay stars.
  assert.deepEqual(parseInline("[**x**](https://a.io)"), [{ type: "link", href: "https://a.io", text: "**x**" }]);
  // A heading inside a list item, a quote, a table and a rule are not constructs.
  assert.deepEqual(parseRichText("- # big"), [{ type: "list", ordered: false, start: 1, items: [[text("# big")]] }]);
  for (const plain of ["> quoted", "| a | b |\n|---|---|", "---", "<b>bold</b>"]) {
    assert.deepEqual(parseRichText(plain), [{ type: "paragraph", children: [text(plain)] }], plain);
  }
});

test("markers with nothing to close them stay text", () => {
  for (const plain of ["**open", "`open", "[label](", "[label]", "a ** b ** c", "**", "``", "[](https://a.io)"]) {
    const nodes = parseInline(plain);
    assert.equal(nodes.filter((n) => n.type === "bold" || n.type === "code").length, 0, plain);
    assert.equal(plainTextOf([{ type: "paragraph", children: nodes }]), plain, plain);
  }
});

test("no HTML passes through: tags stay visible text", () => {
  for (const html of [
    "<script>steal(1)</script>",
    '<img src=x onerror="steal(1)">',
    '<a href="javascript:steal(1)">x</a>',
    "<iframe src=https://evil.example></iframe>",
    "**<script>steal(1)</script>**",
    "# <img src=x onerror=steal(1)>",
    "- <svg onload=steal(1)>",
  ]) {
    const blocks = parseRichText(html);
    // The tree has no node kind that could carry markup, and no character is lost.
    assert.ok(plainTextOf(blocks).includes(html.replace(/^(\*\*|# |- )/, "").replace(/\*\*$/, "")), html);
    for (const block of blocks) {
      assert.ok(["heading", "paragraph", "list", "code"].includes(block.type));
    }
  }
  assert.deepEqual(parseRichText("<script>steal(1)</script>"), [
    { type: "paragraph", children: [text("<script>steal(1)</script>")] },
  ]);
  assert.deepEqual(parseRichText('<img src=x onerror="steal(1)">'), [
    { type: "paragraph", children: [text('<img src=x onerror="steal(1)">')] },
  ]);
});

test("links are http or https only", () => {
  for (const bad of [
    "javascript:steal(1)",
    "JaVaScRiPt:steal(1)",
    " javascript:steal(1)",
    "data:text/html,<script>steal(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "mailto:a@b.co",
    "//example.com/x",
    "/dashboard",
    "example.com",
    "https://",
    "https://exa mple.com",
    "http://a.io/\u0000x",
    "",
  ]) {
    assert.equal(safeHref(bad), null, JSON.stringify(bad));
    const src = `[click](${bad})`;
    const blocks = parseRichText(`See ${src} now`);
    // Nothing but a well-formed http or https address ever becomes a link.
    for (const href of hrefsOf(blocks)) assert.match(href, /^https?:\/\/[^\s]+$/i, JSON.stringify(bad));
    if (!/^\s*https?:/i.test(bad)) assert.deepEqual(hrefsOf(blocks), [], JSON.stringify(bad));
    assert.ok(plainTextOf(blocks).includes("[click]("), JSON.stringify(bad));
  }
  assert.equal(safeHref("https://example.com/a?b=c#d"), "https://example.com/a?b=c#d");
  assert.equal(safeHref("HTTP://EXAMPLE.COM"), "HTTP://EXAMPLE.COM");
  assert.deepEqual(hrefsOf(parseRichText("[a](https://a.io) and [b](http://b.io) and javascript:steal(1) and data:x")), [
    "https://a.io",
    "http://b.io",
  ]);
  // An address hidden behind another scheme is not picked out of it.
  assert.deepEqual(hrefsOf(parseRichText("[x](javascript:location='https://evil.example')")).filter((h) => !/^https?:\/\//i.test(h)), []);
});

test("every link in any answer starts with http:// or https://", () => {
  const nasty = [
    "[a](javascript://example.com/%0Asteal(1))",
    "[a](https://ok.example) [b](data:text/html;base64,AAAA)",
    "xhttps://glued.example and https://fine.example",
    "[a]( https://spaced.example )",
    "[a](\tjavascript:steal(1))",
  ].join("\n\n");
  const hrefs = hrefsOf(parseRichText(nasty));
  assert.ok(hrefs.length >= 3);
  for (const href of hrefs) assert.match(href, /^https?:\/\/[^\s]+$/i);
  assert.ok(!hrefs.some((h) => h.includes("glued")));
});

test("very long input does not blow up", () => {
  const started = Date.now();

  // Over the limit: one paragraph of plain text, nothing lost.
  const huge = "word ".repeat(MAX_RICH_CHARS / 2);
  const flat = parseRichText(huge);
  assert.equal(flat.length, 1);
  assert.equal(plainTextOf(flat), huge);

  // Under the limit, shapes that would be slow for a careless scanner.
  const n = MAX_RICH_CHARS - 10;
  for (const cruel of [
    "[".repeat(n),
    "[".repeat(n - 1) + "]",
    "[a](".repeat(n / 4),
    "**".repeat(n / 2),
    "** ".repeat(n / 3),
    "`".repeat(n),
    "` ".repeat(n / 2),
    "#".repeat(n),
    " ".repeat(n) + "x",
    "- ".repeat(n / 2),
    "https://".repeat(n / 8),
    "h".repeat(n),
    "- a\n".repeat(n / 4),
    "\n".repeat(n),
    "```\n".repeat(n / 4),
    "a".repeat(n),
  ]) {
    const blocks = parseRichText(cruel);
    assert.ok(Array.isArray(blocks));
  }

  // A long ordinary answer keeps its shape.
  const answer = "## Section\n\nSome **bold** text with `code` and https://example.com/x.\n\n- one\n- two\n\n".repeat(1500);
  const blocks = parseRichText(answer);
  assert.equal(blocks.length, 4500);

  // Large JSON is still one block.
  const bigJson = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ i, name: `row ${i}` })));
  assert.equal(parseRichText(bigJson).length, 1);

  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
});

test("plainTextOf drops the markers and keeps the words", () => {
  assert.equal(plainTextOf(parseRichText("# Hi\n\n**a** `b` [c](https://c.io)\n\n1. x\n2. y")), "Hi\na b c\nx\ny");
});

// ============================================
// Emphasis
// ============================================

const em = (...children: RichInline[]): RichInline => ({ type: "em", children });

test("single asterisks and single underscores are emphasis", () => {
  assert.deepEqual(parseInline("*I've completed the morning briefing as requested.*"), [
    em(text("I've completed the morning briefing as requested.")),
  ]);
  assert.deepEqual(parseInline("This is _really_ good, (*truly*)."), [
    text("This is "),
    em(text("really")),
    text(" good, ("),
    em(text("truly")),
    text(")."),
  ]);
  assert.deepEqual(parseInline("*Note:* see `a_b` and *more*"), [
    em(text("Note:")),
    text(" see "),
    { type: "code", text: "a_b" },
    text(" and "),
    em(text("more")),
  ]);
});

test("a list item that starts with an asterisk is a list, not emphasis", () => {
  assert.deepEqual(parseRichText("* first *item*\n* second"), [
    { type: "list", ordered: false, start: 1, items: [[text("first "), em(text("item"))], [text("second")]] },
  ]);
  // A lone "* " in running text opens nothing.
  assert.deepEqual(parseInline("* not a list here* either"), [text("* not a list here* either")]);
});

test("arithmetic keeps its asterisks", () => {
  for (const sum of ["2 * 3 * 4", "2*3*4", "a * b = c * d", "*args and **kwargs"]) {
    assert.deepEqual(parseInline(sum), [text(sum)], sum);
  }
});

test("underscores inside words stay as they are", () => {
  for (const words of ["snake_case and file_names_here", "my_file_name.txt", "__init__ and __main__", "_private_var", "a_ b _c"]) {
    assert.deepEqual(parseInline(words), [text(words)], words);
  }
});

test("bold still works, beside emphasis and around it", () => {
  assert.deepEqual(parseInline("**bold** and *soft*"), [
    { type: "bold", children: [text("bold")] },
    text(" and "),
    em(text("soft")),
  ]);
  assert.deepEqual(parseInline("**a _b_ c**"), [{ type: "bold", children: [text("a "), em(text("b")), text(" c")] }]);
  assert.deepEqual(parseInline("**unclosed and *also unclosed"), [text("**unclosed and *also unclosed")]);
});

test("emphasis does not reach across a blank line, and never holds HTML or an unsafe link", () => {
  assert.deepEqual(parseInline("*one\n\ntwo*"), [text("*one\n\ntwo*")]);
  assert.deepEqual(parseInline("*<b>x</b>*"), [em(text("<b>x</b>"))]);
  assert.deepEqual(parseInline("*[x](javascript:void(0))*"), [em(text("[x](javascript:void(0))"))]);
  assert.equal(plainTextOf(parseRichText("A *soft* word and a _second_ one")), "A soft word and a second one");
});

test("many unclosed markers stay quick", () => {
  const started = Date.now();
  const blocks = parseRichText("*a _b ".repeat(30_000));
  assert.ok(Date.now() - started < 2_000);
  assert.equal(blocks.length, 1);
});
