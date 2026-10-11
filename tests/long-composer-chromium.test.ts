import { expect, test } from "bun:test";
import { constants, accessSync } from "node:fs";
import { chromium, type Locator, type Page } from "playwright-core";
import {
  ChatGptBrowserWorker,
  CHATGPT_COMPOSER_DOCUMENT_END_KEY,
  composerTransportText,
  insertPlainTextIntoComposer,
  splitComposerRecoveryText,
} from "../src/adapters/chatgpt-web/browser-worker";

// Keep this test independent of a browser profile, ChatGPT account, and network access.
const chromePath = [
  process.env.CHATGPT_DOM_TEST_BROWSER,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(path => {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

const scenarios = [
  {
    name: "LF at a segment boundary",
    // Reproduce the exact UTF-16 payload size in the reported Desktop failure.
    input: "a".repeat(63_999) + "\n" + "b".repeat(196_235),
    expected: undefined,
    initialMarkup: "",
  },
  {
    name: "astral Unicode across UTF-16 boundaries",
    input: "x".repeat(63_999) + "🌏" + "e\u0301 — 漢字 — 👩🏽‍💻\n" + "z".repeat(65_000),
    expected: undefined,
    initialMarkup: "",
  },
  {
    name: "literal nested HTML text beside nested connector and cursor nodes",
    input: "<section><span>literal `markup`</span></section>\n" + "t".repeat(128_000),
    expected: undefined,
    initialMarkup: '<span data-id="plugin:fixture" data-keyword="Connector" contenteditable="false">Connector</span><span class="nested"><strong data-inline-selection-pill-cursor-target>Cursor</strong></span>',
  },
  {
    name: "CRLF at a segment boundary uses browser LF canonicalization",
    input: "q".repeat(63_999) + "\r\n" + "next\r\n" + "w".repeat(65_000),
    expected: "LF" as const,
    initialMarkup: "",
  },
] as const;

for (const scenario of scenarios) {
  test.skipIf(!chromePath)(`segmented Chromium composer readback: ${scenario.name}`, async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    try {
      const context = await browser.newContext({ offline: true });
      const page = await context.newPage();
      const composer = page.locator("#prompt-textarea");
      // Exercise the actual readback used to decide whether a prompt can be sent.
      const worker = Object.create(ChatGptBrowserWorker.prototype) as {
        activeComposer(page: Page): Promise<Locator>;
        attachedPromptText(page: Page): Promise<string>;
      };
      worker.activeComposer = async () => composer;

      await page.setContent('<div id="prompt-textarea" role="textbox" contenteditable="true"></div>');
      if (scenario.initialMarkup) {
        await composer.evaluate((element, markup) => { element.innerHTML = markup; }, scenario.initialMarkup);
      }
      expect(await worker.attachedPromptText(page)).toBe("");
      const parts = splitComposerRecoveryText(scenario.input);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.join("")).toBe(scenario.input);
      expect(parts.every(part => part.length <= 64_000)).toBeTrue();
      expect(parts.slice(0, -1).every(part => !/[\uD800-\uDBFF\r]$/.test(part))).toBeTrue();

      for (const part of parts) {
        expect(await composer.evaluate(insertPlainTextIntoComposer, part)).toBeTrue();
      }
      const expected = scenario.expected === "LF"
        ? scenario.input.replace(/\r\n/g, "\n")
        : scenario.input;
      const observed = await worker.attachedPromptText(page);
      expect(observed.length).toBe(expected.length);
      expect(observed === expected).toBeTrue();
      if (scenario.initialMarkup) {
        expect(await composer.locator(".nested strong").textContent()).toBe("Cursor");
        expect(await composer.locator('[data-id="plugin:fixture"]').count()).toBe(1);
      }
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);
}

for (const [expectedChars, commonPrefixChars] of [[233_873, 193_793], [55_390, 42_627]]) {
  test.skipIf(!chromePath)(`inline DOM fragmentation reproduces reported +593 mismatch (${expectedChars})`, async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    try {
      const context = await browser.newContext({ offline: true });
      const page = await context.newPage();
      await page.setContent('<div id="prompt-textarea" contenteditable="true"></div>');
      const prompt = "a".repeat(commonPrefixChars) + "b".repeat(expectedChars - commonPrefixChars);
      const composer = page.locator("#prompt-textarea");
      // A layout/formatting change may fragment one logical line into inline text runs.
      // These are synthetic structures, not a capture of the user's private draft.
      await composer.evaluate((element, { prompt, commonPrefixChars }) => {
        element.append(document.createTextNode(prompt.slice(0, commonPrefixChars)));
        const tail = prompt.slice(commonPrefixChars);
        for (let index = 0; index < 593; index += 1) {
          const span = document.createElement("span");
          span.textContent = tail.slice(Math.floor(index * tail.length / 593), Math.floor((index + 1) * tail.length / 593));
          element.append(span);
        }
      }, { prompt, commonPrefixChars });
      const legacy = await composer.evaluate(element => [...element.childNodes].map(node => node.textContent ?? "").join("\n"));
      expect(legacy.length).toBe(expectedChars + 593);
      expect(legacy.slice(0, commonPrefixChars)).toBe(prompt.slice(0, commonPrefixChars));
      expect(legacy[commonPrefixChars]).not.toBe(prompt[commonPrefixChars]);
      const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => composer });
      expect(await worker.attachedPromptText(page)).toBe(prompt);
    } finally {
      await browser.close();
    }
  }, 30_000);
}

test.skipIf(!chromePath)("production composer transport accepts CRLF and verifies every line", async () => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    await page.setContent('<div id="prompt-textarea" contenteditable="true"></div>');
    const composer = page.locator("#prompt-textarea");
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => composer });
    const source = "  start\r\n" + ("body" + "x".repeat(100) + "\r\n").repeat(1_000) + "\rend";
    await worker.insertPromptText(page, source, undefined, true);
    const observed = await worker.attachedPromptText(page);
    const transport = composerTransportText(source);
    // Chromium represents repeated spaces using NBSP to preserve their visual width.
    // Production verification restricts this allowance to the original space runs.
    expect(observed.length).toBe(transport.length);
    expect(observed.slice(2)).toBe(transport.slice(2));
    expect(worker.promptTextEquivalent(source, observed)).toBeTrue();
    await worker.assertPromptAttached(page, source);
    expect(source.includes("\r\n")).toBeTrue();
  } finally {
    await browser.close();
  }
}, 30_000);

test.skipIf(!chromePath)("connector insertion owns one separator and preserves the prompt's own whitespace", async () => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    const composer = page.locator("#prompt-textarea");
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => composer });
    for (const separator of ["", " ", "\u00A0"]) {
      for (const prefix of ["", "  ", "\n"]) {
        await page.setContent('<div id="prompt-textarea" contenteditable="true" style="white-space:pre-wrap"><p><span app-mention-path="app://fixture" app-mention-display-name="Connector" contenteditable="false">Connector</span></p></div>');
        await composer.evaluate((element, separator) => element.firstChild!.appendChild(document.createTextNode(separator)), separator);
        const text = prefix + "x".repeat(96_240 - prefix.length);
        await composer.focus();
        await composer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY);
        await worker.insertPromptText(page, text, undefined, false, true);
        const observed = await worker.attachedPromptText(page);
        expect(observed.length).toBe(text.length);
        expect(worker.promptTextEquivalent(text, observed)).toBeTrue();
      }
    }
    await context.close();
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!chromePath)("recovery uses another edit below 64k and preserves literal markup, Unicode and line boundaries", async () => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    const composer = page.locator("#prompt-textarea");
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => composer });
    const compact = "a".repeat(42_627) + "\n" + ("z".repeat(20) + "\n").repeat(592) + "z".repeat(330);
    expect(compact.length).toBe(55_390);
    for (const text of [compact, "\n  <script>alert('literal')</script>\t🌏\n\nlast\n", "x".repeat(63_999) + "\n\n" + "y".repeat(70_000) + "\n\n"]) {
      await page.setContent('<div id="prompt-textarea" contenteditable="true"></div>');
      await worker.insertPromptText(page, text, undefined, true);
      const observed = await worker.attachedPromptText(page);
      expect(observed.length).toBe(text.length);
      expect(worker.promptTextEquivalent(text, observed)).toBeTrue();
      expect(await composer.locator("script").count()).toBe(0);
    }
    await context.close();
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!chromePath)("browser CRLF representation reproduces +593 and compares as complete LF transport", async () => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    await page.setContent('<div id="prompt-textarea" contenteditable="true"></div>');
    const composer = page.locator("#prompt-textarea");
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => composer });
    const prompt = "a".repeat(42_627) + "\n" + ("z".repeat(20) + "\n").repeat(592) + "z".repeat(330);
    const browserText = prompt.replace(/\n/g, "\r\n");
    // The real ChatGPT editor retains CRs at the end of its paragraph text.
    // Plain contenteditable Chromium normalizes them, so reproduce that observed
    // structural representation directly, without changing the production reader.
    await composer.evaluate((element, text) => {
      text.split("\n").forEach(line => {
        const paragraph = document.createElement("p");
        paragraph.textContent = line;
        element.append(paragraph);
      });
    }, browserText);
    const observed = await worker.attachedPromptText(page);
    expect(observed.length).toBe(55_983);
    expect(observed.slice(0, 42_627)).toBe(prompt.slice(0, 42_627));
    expect(worker.promptTextEquivalent(prompt, observed)).toBeTrue();
    expect(worker.promptTextEquivalent(prompt, observed.replace(/\r\n/g, ""))).toBeFalse();
    await worker.assertPromptAttached(page, prompt);
    await context.close();
  } finally { await browser.close(); }
}, 30_000);
