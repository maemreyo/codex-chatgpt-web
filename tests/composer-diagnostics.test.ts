import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { compareComposerText, readComposerDom, summarizeComposerMismatch, type ComposerDomSnapshot } from "../src/adapters/chatgpt-web/composer-diagnostics";
import { ChatGptBrowserDiagnostics, ChatGptBrowserWorker, ChatGptPromptAttachmentIntegrityError, pruneBrowserDiagnostics, sanitizeChatGptBrowserDiagnosticState } from "../src/adapters/chatgpt-web/browser-worker";

const chrome = process.env.CODEX_CHATGPT_WEB_CHROME_EXECUTABLE
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test.skipIf(!existsSync(chrome))("late aria decoration does not block a complete draft or conceal authored mutation", async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    await page.setContent('<div id="prompt-textarea" data-composer-markdown contenteditable="true"></div>');
    const composer = page.locator("#prompt-textarea");
    const expected = "a".repeat(42_627) + "b".repeat(55_390 - 42_627 - 17) + "\n".repeat(17);
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => composer });
    for (const paragraphs of [true, false]) {
      await composer.evaluate((element, { expected, paragraphs }) => {
        element.replaceChildren();
        const lines = expected.split("\n");
        const first = document.createElement("p");
        first.append(document.createTextNode(lines[0]!.slice(0, 42_627)));
        const token = document.createElement("span");
        token.contentEditable = "false";
        const decoration = document.createElement("span");
        decoration.setAttribute("aria-hidden", "true");
        decoration.textContent = "x".repeat(593);
        token.append(decoration);
        first.append(token, document.createTextNode(lines[0]!.slice(42_627)));
        element.append(first);
        for (const line of lines.slice(1)) {
          if (paragraphs) { const p = document.createElement("p"); p.textContent = line; element.append(p); }
          else first.append(document.createElement("br"), document.createTextNode(line));
        }
      }, { expected, paragraphs });
      expect((await composer.textContent())!.length).toBe(55_966);
      expect(await worker.attachedPromptText(page)).toBe(expected);
      await worker.assertPromptAttached(page, expected);
      await composer.evaluate(element => {
        const text = document.createElement("span");
        text.contentEditable = "false";
        text.textContent = "authored-token-label";
        element.append(text);
      });
      // Ordinary noneditable labels remain in the comparison; they are not blanket-stripped.
      expect(worker.promptTextEquivalent(expected, await worker.attachedPromptText(page))).toBeFalse();
    }
    const literal = '<span aria-hidden="true">literal source</span>';
    await worker.insertPromptText(page, literal); // The prior draft is deliberately still present.
    expect(await worker.attachedPromptText(page)).toContain(literal);
    await composer.fill("");
    await composer.evaluate(element => {
      const editable = document.createElement("span");
      editable.setAttribute("aria-hidden", "true");
      editable.contentEditable = "true";
      editable.textContent = "authored text";
      element.append(editable);
    });
    expect(await worker.attachedPromptText(page)).toBe("authored text");
  } finally { await browser.close(); }
}, 30_000);

test("mismatch diagnostics preserve offsets and categories without retaining text", () => {
  const expected = "private-secret " + "a".repeat(20);
  const actual = expected.slice(0, 15) + "\\".repeat(593) + expected.slice(15);
  const report = compareComposerText(expected, actual);
  expect(report.commonPrefixChars).toBe(15);
  expect(report.expectedChangedChars).toBe(0);
  expect(report.observedChangedChars).toBe(593);
  expect(report.observedChangedProfile.backslash).toBe(593);
  expect(report.insertionOnly).toBeTrue();
  expect(report.insertedProfile.backslash).toBe(593);
  expect(JSON.stringify(report)).not.toContain("private-secret");
  expect(compareComposerText("a  b", "a\u00A0 b").matches).toBeTrue();
  expect(compareComposerText("a b", "a\u00A0b").matches).toBeFalse();
  expect(compareComposerText("a\r\nb", "a\nb").matches).toBeTrue();
});

for (const paragraphs of [true, false]) {
  test.skipIf(!existsSync(chrome))(`observed +593 layout distinguishes hidden text from real mutation (paragraphs=${paragraphs})`, async () => {
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const context = await browser.newContext({ offline: true });
      const page = await context.newPage();
      await page.setContent('<div id="prompt-textarea" data-composer-markdown contenteditable="true"></div>');
      const composer = page.locator("#prompt-textarea");
      const expected = "a".repeat(42_627) + "b".repeat(55_390 - 42_627 - 17) + "\n".repeat(17);
      for (const hidden of [true, false]) {
        await composer.evaluate((element, { expected, paragraphs, hidden }) => {
          element.replaceChildren();
          const lines = expected.split("\n");
          const first = document.createElement("p");
          first.append(document.createTextNode(lines[0]!.slice(0, 42_627)));
          const extra = document.createElement("span");
          extra.textContent = "x".repeat(593);
          if (hidden) extra.style.display = "none";
          first.append(extra, document.createTextNode(lines[0]!.slice(42_627)));
          element.append(first);
          for (const line of lines.slice(1)) {
            if (paragraphs) {
              const p = document.createElement("p");
              p.textContent = line;
              element.append(p);
            } else first.append(document.createElement("br"), document.createTextNode(line));
          }
        }, { expected, paragraphs, hidden });
        const snapshot = await composer.evaluate(readComposerDom, true) as ComposerDomSnapshot;
        const report = summarizeComposerMismatch(expected, snapshot, { edits: [], lastImmediateRawText: snapshot.rawText });
        expect(report.reconstructed).toMatchObject({ expectedChars: 55_390, observedChars: 55_983, commonPrefixChars: 42_627 });
        expect(snapshot.rawText.length).toBe(55_966);
        expect(report.hiddenContributionExplainsMismatch).toBe(hidden);
        expect(report.rawChangedAfterEditingCommand).toBeFalse();
        expect(report.cssVisible.matches).toBe(hidden);
        expect(snapshot.structure.lineBreaks).toBe(paragraphs ? 0 : 17);
        expect(snapshot.structure.paragraphs).toBe(paragraphs ? 18 : 1);
        expect(report.reconstructed.matches).toBeFalse(); // Advisory probes never authorize Send.
      }
    } finally { await browser.close(); }
  }, 30_000);
}

test.skipIf(!existsSync(chrome))("production attachment captures reconciliation changes before cleanup without private text", async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    await page.setContent('<div id="prompt-textarea" data-composer-markdown contenteditable="true"></div>');
    const composer = page.locator("#prompt-textarea");
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      activeComposer: async () => composer,
      assertPromptAttached: async () => {
        await composer.evaluate(element => element.append(document.createTextNode("\\".repeat(593))));
        throw new ChatGptPromptAttachmentIntegrityError("synthetic mismatch");
      },
      clearChatGptComposerState: async () => composer.fill(""),
    });
    let diagnostic: any;
    let draftPresentAtCapture = false;
    await expect(worker.attachPrompt(page, "private-secret-prompt", false, async (_checkpoint: string, error: ChatGptPromptAttachmentIntegrityError) => {
      draftPresentAtCapture = (await composer.textContent())!.length > 0;
      diagnostic = sanitizeChatGptBrowserDiagnosticState(error.attachmentDiagnostic);
    })).rejects.toThrow("synthetic mismatch");
    expect(draftPresentAtCapture).toBeTrue();
    expect(await composer.textContent()).toBe("");
    expect(diagnostic.rawChangedAfterEditingCommand).toBeTrue();
    expect(diagnostic.editingCommands[0]).toMatchObject({ index: 0, total: 1, applied: true });
    expect(diagnostic.editingCommands[0].immediateProfile.chars).toBe(21);
    expect(diagnostic.reconstructed.observedChangedChars).toBe(593);
    const encoded = JSON.stringify(diagnostic);
    expect(encoded).not.toContain("private-secret");
    expect(encoded).not.toContain("immediateText");
    expect(encoded).not.toContain("rawText");
  } finally { await browser.close(); }
}, 30_000);

test("successful traffic cannot evict recent failed attachment evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "composer-diagnostic-retention-"));
  try {
    const failure = join(root, "failed-trace-0001");
    mkdirSync(failure);
    writeFileSync(join(failure, "attachment-failure.json"), "{}");
    for (let i = 0; i < 25; i += 1) mkdirSync(join(root, `success-trace-${String(i).padStart(4, "0")}`));
    pruneBrowserDiagnostics(root);
    expect(existsSync(join(failure, "attachment-failure.json"))).toBeTrue();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("successful traffic cannot evict recent generic turn failures", () => {
  const root = mkdtempSync(join(tmpdir(), "turn-failure-retention-"));
  try {
    const failure = join(root, "failed-trace-0001");
    mkdirSync(failure);
    writeFileSync(join(failure, "38-turn-failed.json"), JSON.stringify({ checkpoint: "turn-failed" }));
    for (let i = 0; i < 25; i += 1) mkdirSync(join(root, `success-trace-${String(i).padStart(4, "0")}`));
    pruneBrowserDiagnostics(root);
    expect(existsSync(join(failure, "38-turn-failed.json"))).toBeTrue();
    expect(readdirSync(root).length).toBe(11);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("generic turn failure retention remains bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "turn-failure-retention-cap-"));
  try {
    for (let i = 0; i < 25; i += 1) {
      const dir = join(root, `failed-trace-${String(i).padStart(4, "0")}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "38-turn-failed.json"), "{}");
    }
    pruneBrowserDiagnostics(root);
    expect(readdirSync(root).length).toBe(20);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Markdown failure evidence survives retention and never persists answer text", async () => {
  const root = mkdtempSync(join(tmpdir(), "markdown-failure-retention-"));
  try {
    const capture = new ChatGptBrowserDiagnostics("markdown_failure_trace", root, "fixture");
    const page: any = { screenshot: async () => { throw new Error("screenshot not expected"); },
      evaluate: async () => ({ documentComplete: true }) };
    await capture.capture(page, "send-accepted");
    capture.recordMarkdownFailure({
      stage: "finish", reason: "unanchored_tail",
      ledger: { mode: "verified", committedBlocks: 1, committedRangedBlocks: 1,
        committedTextChars: 21, pendingBlocks: 0, pendingRangedBlocks: 0,
        pendingTextChars: 0, emittedMarkdownChars: 21 },
      observedBlocks: 1, observedRangedBlocks: 0, observedTextChars: 18,
      visibleTextChars: 18, completionActionVisible: true,
    });
    capture.settle();
    const directory = join(root, readdirSync(root)[0]!);
    const report = readFileSync(join(directory, "markdown-failure.json"), "utf8");
    expect(JSON.parse(report)).toMatchObject({ stage: "finish", reason: "unanchored_tail",
      ledger: { committedBlocks: 1 }, observedBlocks: 1 });
    expect(report).not.toMatch(/private-secret|<p>|href|html|markdown-failure-retention-/);
    for (let i = 0; i < 25; i += 1) mkdirSync(join(root, `success-trace-${String(i).padStart(4, "0")}`));
    pruneBrowserDiagnostics(root);
    expect(existsSync(join(directory, "markdown-failure.json"))).toBeTrue();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("active traces survive pruning and settled mismatch capture never takes a screenshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "composer-active-retention-"));
  const previous = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = "1";
  try {
    let screenshots = 0;
    const page: any = {
      screenshot: async () => { screenshots += 1; return Buffer.from("private draft screenshot"); },
      evaluate: async () => ({ documentComplete: true }),
    };
    const capture = new ChatGptBrowserDiagnostics("active_test_trace", root, "fixture");
    const error = new ChatGptPromptAttachmentIntegrityError("synthetic mismatch");
    await capture.capture(page, "prompt-attachment-integrity-mismatch", error);
    const directory = join(root, readdirSync(root)[0]!);
    expect(existsSync(join(directory, "active.json"))).toBeTrue();
    // Simulate an active multipart trace before its first failure marker exists.
    rmSync(join(directory, "attachment-failure.json"));
    for (let i = 0; i < 25; i += 1) mkdirSync(join(root, `success-trace-${String(i).padStart(4, "0")}`));
    pruneBrowserDiagnostics(root);
    expect(existsSync(directory)).toBeTrue();
    await capture.capture(page, "prompt-attachment-integrity-mismatch", error);
    capture.settle();
    expect(existsSync(join(directory, "active.json"))).toBeFalse();
    expect(existsSync(join(directory, "attachment-failure.json"))).toBeTrue();
    expect(JSON.parse(readFileSync(join(directory, "attachment-failure.json"), "utf8")).attachmentDiagnostic.observationFailed).toBeTrue();
    expect(screenshots).toBe(0);
    expect(readdirSync(directory).some(name => name.endsWith(".png"))).toBeFalse();
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
