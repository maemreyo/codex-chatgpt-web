import { expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError, chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("atomic summaries accept a revised draft while ordinary streamed answers still reject changes", () => {
  const first = { key: "a", tag: "p", html: "<p>Earlier summary.</p>", text: "Earlier summary.", streamable: true };
  const second = { key: "b", tag: "p", html: "<p>Final detail.</p>", text: "Final detail.", streamable: true };
  const revised = { ...first, html: "<p>Corrected summary.</p>", text: "Corrected summary." };
  const summary = new ChatGptMarkdownBuffer(undefined, 0, "complete");
  const answer = new ChatGptMarkdownBuffer(undefined, 0);
  for (const draft of [[first, second], [first, second], [second, revised]]) {
    expect(summary.observe(draft)).toBe("");
    answer.observe(draft);
  }
  expect(summary.finish()).toEqual({
    markdown: "Final detail.\n\nCorrected summary.", delta: "Final detail.\n\nCorrected summary.",
  });
  expect(() => answer.finish()).toThrow("completed text block");
});

function katex(source: string, display = false): string {
  const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const math = '<span class="katex"><span class="katex-mathml"><math><semantics>'
    + '<mrow><mi>ACCESSIBLE_COPY</mi><mo>\u2061</mo></mrow>'
    + `<annotation encoding="application/x-tex">${escaped}</annotation>`
    + '</semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL_COPY\u200b</span></span>';
  return display ? `<span class="katex-display">${math}</span>` : math;
}

test("KaTeX inline and display formulas preserve exactly one original LaTeX expression", () => {
  const inline = String.raw`E = mc^2`;
  const display = String.raw`r_{\mathrm{eff}} = \exp\left(-\sum_i q_i \log q_i\right)`;
  expect(chatGptHtmlToMarkdown(`<p>Inline: ${katex(inline)}.</p>${katex(display, true)}`)).toBe(
    `Inline: \\(${inline}\\).\n\n\\[\n${display}\n\\]`,
  );
});

test("math source survives lists, links, nested braces, Unicode, and wiki-shaped expressions", () => {
  const source = String.raw`\operatorname{rank}\left(\frac{α_{i}}{1+β}\right) < 2 \quad [[x]]`;
  expect(chatGptHtmlToMarkdown(
    `<ul><li>Value ${katex(source)}; <a href="https://example.com">reference</a>.</li></ul>`
      + '<p>Open [[Notes/math|notes]].</p>' + katex(`${source}\n+ γ`, true),
  )).toBe(`- Value \\(${source}\\); [reference](https://example.com).\n\n`
    + `Open [notes](<Notes/math.md>).\n\n\\[\n${source}\n+ γ\n\\]`);
  const code = String.raw`\frac{a_b}{c} [[literal]]`;
  expect(chatGptHtmlToMarkdown(`<p><code>${code}</code></p><pre><code>${code}</code></pre>`))
    .toBe(`\`${code}\`\n\n\`\`\`\n${code}\n\`\`\``);
});

test("LaTeX comment newlines survive generic HTML whitespace normalization", () => {
  const source = "a % comment\n+ b";
  expect(chatGptHtmlToMarkdown(katex(source, true))).toBe(`\\[\n${source}\n\\]`);
});

test("unknown or ambiguous KaTeX source fails instead of inventing a formula", () => {
  const formula = katex("x");
  expect(() => chatGptHtmlToMarkdown(formula.replace(/<annotation[^>]*>.*?<\/annotation>/, "")))
    .toThrow("one unambiguous LaTeX source");
  expect(() => chatGptHtmlToMarkdown(formula.replace("</semantics>",
    '<annotation encoding="application/x-tex">y</annotation></semantics>')))
    .toThrow("one unambiguous LaTeX source");
});

test("streaming formulas once still rejects a rewrite of committed math", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const segment = (source: string) => ({
    key: "formula", tag: "p", text: `ACCESSIBLE_COPY${source}VISUAL_COPY`,
    html: `<p>${katex(source)}</p>`, streamable: true,
  });
  expect(buffer.observe([segment("x_1")], 0)).toBe(String.raw`\(x_1\)`);
  expect(buffer.observe([segment("x_1")], 1)).toBe("");
  buffer.observe([segment("x_2")], 2);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_Editor\file.cs`,
      target: "C:/Codex_Project_Unity/_Editor/file.cs",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_file.cs`,
      target: "C:/Codex_Project_Unity/_file.cs",
    },
    {
      path: String.raw`\\server\share_name\_Editor\file.cs`,
      target: "//server/share_name/_Editor/file.cs",
    },
    {
      path: "src/_private_/file_name.ts",
      target: "src/_private_/file_name.ts",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    const markdown = chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`);
    expect(markdown).toContain(`](<${target}>)`);
    expect(Bun.markdown.html(markdown))
      .toBe(`<p>Created <a href="${target}">${path}</a>.</p>\n`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>\`\`\`not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
    "",
    "Keep `[[wiki/example]]` and ![[image.png]] literal.",
    "",
    "````",
    "```not a closing fence",
    "[[wiki/fenced]]",
    "````",
  ].join("\n"));
});

test("preserves standalone Codex plan markers in paragraphs and list continuations", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>&lt;proposed_plan&gt;</p>",
    "<h2>Plan</h2>",
    "<ul><li><p>Keep snake_case.</p><p>&lt;/proposed_plan&gt;</p></li></ul>",
  ].join(""))).toBe([
    "<proposed_plan>", "", "## Plan", "", "- Keep snake\\_case.", "  ", "  </proposed_plan>",
  ].join("\n"));
  expect(chatGptHtmlToMarkdown("<p>&lt;proposed_plan&gt;<br>Step<br>&lt;/proposed_plan&gt;</p>"))
    .toBe("<proposed_plan>  \nStep  \n</proposed_plan>");
});

test("preserving plan markers does not rewrite mentions or literal code", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>Mention &lt;proposed_plan&gt; and &lt;/proposed_plan&gt; inline.</p>",
    "<p><code>&lt;proposed_plan&gt;</code> <code>&lt;/proposed_plan&gt;</code></p>",
    "<pre><code>&lt;proposed\\_plan&gt;\n&lt;/proposed\\_plan&gt;</code></pre>",
  ].join(""))).toBe([
    "Mention <proposed\\_plan> and </proposed\\_plan> inline.", "",
    "`<proposed_plan>` `</proposed_plan>`", "",
    "```", "<proposed\\_plan>", "</proposed\\_plan>", "```",
  ].join("\n"));
});


test("repeated report headings can first appear after an earlier copy was committed", () => {
  for (const { count, repeated, tag, text } of [
    { count: 93, repeated: [15, 20, 25, 29], tag: "p", text: "変更済み:" },
    { count: 199, repeated: [40, 83], tag: "h2", text: "Functions" },
  ]) {
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    const report = Array.from({ length: count }, (_, index) => {
      const blockTag = repeated.includes(index) ? tag : "p";
      const value = repeated.includes(index) ? text : `Unique block ${index}`;
      return { key: `${index}:${blockTag}`, tag: blockTag, text: value,
        html: `<${blockTag}>${value}</${blockTag}>`, streamable: true };
    });
    for (let length = 2; length <= report.length; length += 1) {
      buffer.observe(report.slice(0, length).map((block, index) => ({
        ...block, streamable: index < length - 1,
      })), length);
      expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
    }
    const expected = report.map(block => chatGptHtmlToMarkdown(block.html)).join("\n\n");
    expect(buffer.finish().markdown).toBe(expected);
    buffer.observe([report[0]!, report[0]!], count + 1);
    expect(() => buffer.finish()).toThrow("changed a completed text block");
  }
});

test("virtualized prefix permits a remounted pending tail when the tag changes but Markdown is identical", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const block = (key: string, tag: string, text: string, streamable: boolean) => ({
    key, tag, text, html: `<${tag}>${text}</${tag}>`, streamable,
  });
  const first = block("initial:first", "p", "Sent already.", true);
  const pending = block("initial:pending", "p", "Stable pending.", false);
  expect(buffer.observe([first, pending], 0)).toBe("Sent already.");

  const remounted = block("final:pending", "div", "Stable pending.", true);
  const tail = block("final:tail", "p", "New final detail.", false);
  expect(buffer.observe([remounted, tail], 1)).toBe("\n\nStable pending.");
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish()).toEqual({
    markdown: "Sent already.\n\nStable pending.\n\nNew final detail.",
    delta: "\n\nNew final detail.",
  });
});

test("virtualized prefix aligns a uniquely remounted committed tail without delivering it twice", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const first = { key: "old:0", tag: "p", text: "Already committed.",
    html: "<p>Already committed.</p>", streamable: true };
  expect(buffer.observe([first], 0)).toBe("Already committed.");
  const remounted = { ...first, key: "new:0", tag: "div", html: "<div>Already committed.</div>" };
  const tail = { key: "new:1", tag: "p", text: "Added later.",
    html: "<p>Added later.</p>", streamable: false };
  expect(buffer.observe([remounted, tail], 1)).toBe("");
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish()).toEqual({
    markdown: "Already committed.\n\nAdded later.", delta: "\n\nAdded later.",
  });
});

test("remounted tails reject rewritten committed text, changed destinations and ambiguous anchors", () => {
  const base = { key: "old:0", tag: "p", text: "Anchor",
    html: "<p>Anchor</p>", streamable: true };
  for (const changed of [
    { key: "new:0", tag: "div", text: "Rewritten", html: "<div>Rewritten</div>", streamable: true },
    { key: "new:0", tag: "div", text: "Anchor", html: "<div><strong>Anchor</strong></div>", streamable: true },
  ]) {
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    buffer.observe([base], 0);
    expect(buffer.observe([changed], 1)).toBe("");
    expect(buffer.currentSnapshotIsConsistent()).toBeFalse();
    expect(() => buffer.finish()).toThrow();
  }
  const links = new ChatGptMarkdownBuffer(undefined, 0);
  const linked = { ...base, html: '<p><a href="https://example.com/a">Anchor</a></p>',
    linkTargets: ["https://example.com/a"] };
  links.observe([linked], 0);
  links.observe([{ ...linked, key: "remounted", tag: "div",
    html: '<div><a href="https://example.com/b">Anchor</a></div>',
    linkTargets: ["https://example.com/b"] }], 1);
  expect(() => links.finish()).toThrow();

  const ambiguous = new ChatGptMarkdownBuffer(undefined, 0);
  const first = { ...base, text: "Repeated", html: "<p>Repeated</p>" };
  ambiguous.observe([first, { ...first, key: "old:1" }], 0);
  ambiguous.observe([{ ...first, key: "remounted", tag: "div", html: "<div>Repeated</div>" }], 1);
  expect(() => ambiguous.finish()).toThrow();

  const collided = new ChatGptMarkdownBuffer(undefined, 0);
  collided.observe([first, { ...first, key: "pending-copy", streamable: false }], 0);
  collided.observe([{ ...first, key: "different-wrapper", tag: "div",
    html: "<div>Repeated</div>" }], 1);
  expect(() => collided.finish()).toThrow("ambiguous committed and pending remount anchors");
});

test("remount inference stays within the recent ledger and rejects a wholly unanchored final tail", () => {
  const block = (index: number, tag = "p") => ({
    key: `${index}:${tag}`, tag, text: `Unique ${index}`,
    html: `<${tag}>Unique ${index}</${tag}>`, streamable: true,
  });
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe(Array.from({ length: 70 }, (_, index) => block(index)), 0);
  buffer.observe([block(0, "div")], 1);
  expect(buffer.currentSnapshotIsConsistent()).toBeFalse();
  expect(() => buffer.finish()).toThrow("could not be aligned");

  const noAnchor = new ChatGptMarkdownBuffer(undefined, 0);
  noAnchor.observe([block(0)], 0);
  noAnchor.observe([block(71)], 1);
  expect(() => noAnchor.finish()).toThrow("could not be aligned");
});

test("a source-ranged remount must preserve the exact rendered committed block", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const original = { key: "0:p", tag: "p", text: "Same visible text",
    html: "<p>Same visible text</p>", sourceStart: 0, sourceEnd: 17, streamable: true };
  buffer.observe([original], 0);
  buffer.observe([{ ...original, key: "0:div", tag: "div",
    html: "<div><strong>Same visible text</strong></div>" }], 1);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

test("source-start remount rejects a changed source end even when delivered text and Markdown match", () => {
  for (const end of [4, 12, undefined]) {
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    const original = { key: "old:0", tag: "p", text: "Stable", html: "<p>Stable</p>",
      sourceStart: 0, sourceEnd: 6, streamable: true };
    expect(buffer.observe([original], 0)).toBe("Stable");
    const remounted = { ...original, key: "new:0", tag: "div", html: "<div>Stable</div>", sourceEnd: end };
    expect(buffer.observe([remounted], 1)).toBe("");
    expect(buffer.currentSnapshotIsConsistent()).toBeFalse();
    try {
      buffer.finish();
      throw new Error("Expected a source-range consistency error");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatGptMarkdownConsistencyError);
      expect((error as ChatGptMarkdownConsistencyError).diagnostic).toMatchObject({
        reason: "source_range_overlap", committedStart: 0, committedEnd: 6,
        observedStart: 0, observedEnd: end, observedTextChars: 6, committedTextChars: 6,
      });
    }
  }

  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const original = { key: "old", tag: "p", html: "<p>Stable</p>", text: "Stable",
    sourceStart: 0, sourceEnd: 6, streamable: true };
  expect(buffer.observe([original], 0)).toBe("Stable");
  expect(buffer.observe([{ ...original, key: "new", tag: "div", html: "<div>Stable</div>" }], 1)).toBe("");
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish()).toEqual({ markdown: "Stable", delta: "" });
});
