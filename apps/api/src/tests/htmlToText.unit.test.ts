import assert from "node:assert/strict";
import test from "node:test";

// Drives services/htmlToText.ts, which turns fetched pages into the text
// a data_sync task stores in a knowledge base.

import { HTML_TO_TEXT_MAX_INPUT, htmlToText } from "../services/htmlToText.js";

test("script, style and other non-content elements are removed with their content", () => {
  const text = htmlToText(`
    <html><head><title>Docs</title><style>body { color: red }</style></head>
    <body>
      <script>alert("x"); var secret = 1;</script>
      <noscript>enable js</noscript>
      <h1>Pricing</h1>
      <p>Plans start at <b>$5</b>.</p>
      <template><p>hidden</p></template>
      <svg><text>icon</text></svg>
    </body></html>`);
  assert.equal(text, "Pricing\n\nPlans start at $5 .");
  for (const gone of ["alert", "secret", "color: red", "enable js", "hidden", "icon", "Docs"]) {
    assert.ok(!text.includes(gone), gone);
  }
});

test("an unclosed script swallows the rest instead of leaking code as prose", () => {
  assert.equal(htmlToText("<p>before</p><script>var a = 1; <p>after</p>"), "before");
});

test("block elements become line breaks and inline whitespace collapses", () => {
  assert.equal(
    htmlToText("<div>one</div><div>two   words</div><ul><li>a</li><li>b</li></ul>line<br>break"),
    "one\n\ntwo words\n\na\n\nb\n\nline\nbreak",
  );
});

test("basic entities are decoded, once", () => {
  assert.equal(htmlToText("<p>Tom &amp; Jerry &lt;3 &quot;cheese&quot; &#39;now&#39; &#x41;&nbsp;B</p>"), "Tom & Jerry <3 \"cheese\" 'now' A B");
  // Double-encoded markup stays text: it must not turn into a tag.
  assert.equal(htmlToText("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  // Escaped markup is text, and stays in the output as text.
  assert.equal(htmlToText("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"), "<script>alert(1)</script>");
  assert.equal(htmlToText("&bogus; &#0; &#99999999;"), "&bogus; &#0; &#99999999;");
});

test("comments are dropped and plain text passes through", () => {
  assert.equal(htmlToText("a <!-- <script>x</script> --> b"), "a b");
  assert.equal(htmlToText("just text"), "just text");
  assert.equal(htmlToText(""), "");
});

test("input is cut at the size cap before any work", () => {
  const html = `<p>${"a".repeat(HTML_TO_TEXT_MAX_INPUT)}</p><p>tail</p>`;
  const text = htmlToText(html);
  assert.ok(text.length <= HTML_TO_TEXT_MAX_INPUT);
  assert.ok(!text.includes("tail"));
});

test("an unclosed comment is not a comment: tags after it are still read", () => {
  assert.equal(htmlToText("a <!-- open <b>x</b> y"), "a x y");
});

test("a non-content element is recognised by its exact name, in any case, closed or not", () => {
  assert.equal(htmlToText("<p>a</p><SCRIPT type='x'>code()</ScRiPt  ><p>b</p>"), "a\n\nb");
  // <header> is not <head>, and a custom element is not a script.
  assert.equal(htmlToText("<header>top</header><script-note>kept</script-note>"), "top\nkept");
  // The opening tag need not be complete to swallow the rest.
  assert.equal(htmlToText("before <style"), "before");
});

test("with no '>' ahead the rest is text, up to a non-content element left open in it", () => {
  assert.equal(htmlToText("3 < 5 and 2 < 4"), "3 < 5 and 2 < 4");
  assert.equal(htmlToText("a < b <script var x = 1"), "a < b");
});

// The page comes from a server the task's author controls and the
// reduction is synchronous inside the API process. The regex version
// took 6 s on 100 KB of "<" and 35 s on 400 KB of "<!--", growing with
// the square of the size: minutes of a frozen process per source. Each
// input below is 2 MB (the largest maxBytes a task may set) and must
// finish in well under a second; the bound is loose so only a return to
// quadratic work can fail it.
test("hostile markup is reduced in linear time", () => {
  const SIZE = 2_000_000;
  const fill = (unit: string, tail = "") => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE) + tail;
  const hostile: Record<string, string> = {
    "only <": fill("<"),
    "only <!--": fill("<!--"),
    "unclosed <p ": fill("<p "),
    "< then one >": fill("<", ">"),
    "<!-- then one >": fill("<!--", ">"),
    "<!-- then one -->": fill("<!--", "-->"),
    "unclosed <script": fill("<script "),
    "<script> then near-closers": "<script>" + fill("</script "),
    "<script> then closers with space": "<script>" + fill("</script" + " ".repeat(64)),
    "tiny tags": fill("<a>"),
    "tiny comments": fill("<!---->"),
    "scripts": fill("<script></script>"),
    "ampersands": fill("&"),
    "near-entities": fill("&#x41"),
    "spaces": fill(" "),
    "line breaks": fill("<br>"),
  };
  for (const [label, html] of Object.entries(hostile)) {
    const started = performance.now();
    const text = htmlToText(html);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2_000, `${label}: ${Math.round(elapsed)}ms`);
    assert.ok(text.length <= html.length, label);
  }
});
