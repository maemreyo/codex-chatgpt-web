/** Raw texts are returned only to in-memory comparison; never persist this snapshot. */
export interface ComposerDomSnapshot {
  text: string;
  rawText: string;
  visibleText: string;
  ariaVisibleText: string;
  editableText: string;
  innerText: string;
  structure: Record<string, number | boolean>;
}

export interface ComposerInsertionJournal {
  edits: Array<Record<string, unknown>>;
  lastImmediateRawText?: string;
}

/** Fixed categories only: no character values, text snippets, hashes or HTML. */
export function composerTextProfile(text: string): Record<string, number> {
  const result: Record<string, number> = {
    chars: text.length, backslash: 0, quote: 0, newline: 0, carriageReturn: 0,
    tab: 0, space: 0, nbsp: 0, zeroWidth: 0, otherControl: 0, surrogate: 0,
    nonAscii: 0, punctuation: 0, letter: 0, digit: 0,
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const key = c === 92 ? "backslash" : c === 34 || c === 39 ? "quote"
      : c === 10 ? "newline" : c === 13 ? "carriageReturn" : c === 9 ? "tab"
      : c === 32 ? "space" : c === 160 ? "nbsp"
      : c === 0x200B || c === 0x200C || c === 0x200D || c === 0xFEFF ? "zeroWidth"
      : c < 32 || c === 127 ? "otherControl"
      : c >= 0xD800 && c <= 0xDFFF ? "surrogate" : c > 127 ? "nonAscii"
      : c >= 48 && c <= 57 ? "digit"
      : c >= 65 && c <= 90 || c >= 97 && c <= 122 ? "letter" : "punctuation";
    result[key]! += 1;
  }
  return result;
}

export function compareComposerText(expected: string, observed: string) {
  expected = expected.replace(/\r\n?/g, "\n");
  observed = observed.replace(/\r\n?/g, "\n");
  const equivalent = (ei: number, oi: number) => expected[ei] === observed[oi]
    || expected[ei] === " " && observed[oi] === "\u00A0"
      && (expected[ei - 1] === " " || expected[ei + 1] === " ");
  let prefix = 0;
  while (prefix < Math.min(expected.length, observed.length) && equivalent(prefix, prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < Math.min(expected.length, observed.length) - prefix
    && equivalent(expected.length - 1 - suffix, observed.length - 1 - suffix)) suffix += 1;
  let matched = 0;
  let inserted = "";
  if (observed.length >= expected.length) {
    for (let i = 0; i < observed.length; i += 1) {
      if (matched < expected.length && equivalent(matched, i)) matched += 1;
      else inserted += observed[i];
    }
  }
  const insertionOnly = matched === expected.length && observed.length > expected.length;
  return {
    matches: expected.length === observed.length && prefix === expected.length,
    expectedChars: expected.length, observedChars: observed.length,
    commonPrefixChars: prefix, commonSuffixChars: suffix,
    expectedChangedChars: expected.length - prefix - suffix,
    observedChangedChars: observed.length - prefix - suffix,
    expectedFirstCategory: composerTextProfile(expected.slice(prefix, prefix + 1)),
    observedFirstCategory: composerTextProfile(observed.slice(prefix, prefix + 1)),
    expectedChangedProfile: composerTextProfile(expected.slice(prefix, expected.length - suffix)),
    observedChangedProfile: composerTextProfile(observed.slice(prefix, observed.length - suffix)),
    expectedProfile: composerTextProfile(expected), observedProfile: composerTextProfile(observed),
    insertionOnly,
    insertedProfile: composerTextProfile(insertionOnly ? inserted : ""),
  };
}

export function summarizeComposerMismatch(
  expected: string,
  snapshot: ComposerDomSnapshot,
  journal: ComposerInsertionJournal,
) {
  const reconstructed = compareComposerText(expected, snapshot.text);
  const cssVisible = compareComposerText(expected, snapshot.visibleText);
  const ariaVisible = compareComposerText(expected, snapshot.ariaVisibleText);
  const editable = compareComposerText(expected, snapshot.editableText);
  const rendered = compareComposerText(expected, snapshot.innerText);
  return {
    schemaVersion: 1, reconstructed, cssVisible, ariaVisible, editable, rendered,
    rawProfile: composerTextProfile(snapshot.rawText), structure: snapshot.structure,
    editingCommands: journal.edits,
    immediateRawAvailable: journal.lastImmediateRawText !== undefined,
    rawChangedAfterEditingCommand: journal.lastImmediateRawText !== undefined
      && journal.lastImmediateRawText !== snapshot.rawText,
    hiddenContributionExplainsMismatch: !reconstructed.matches && cssVisible.matches
      && Number(snapshot.structure.hiddenTextChars) > 0,
    nonEditableContributionExplainsMismatch: !reconstructed.matches && editable.matches,
    renderedTextMatches: rendered.matches,
  };
}

/** Runs in the browser. The default path preserves the production reader exactly. */
export function readComposerDom(element: HTMLElement, diagnostic = false): string | ComposerDomSnapshot {
  const inspect = (text: string, cleaned: HTMLElement, read: (node: Node) => string): ComposerDomSnapshot => {
    const visible = cleaned.cloneNode(true) as HTMLElement;
    const ariaVisible = cleaned.cloneNode(true) as HTMLElement;
    const editable = cleaned.cloneNode(true) as HTMLElement;
    const originals = [cleaned, ...cleaned.querySelectorAll<HTMLElement>("*")];
    const visibleNodes = [visible, ...visible.querySelectorAll<HTMLElement>("*")];
    let hiddenTextChars = 0;
    let hiddenElements = 0;
    let nonEditableElements = 0;
    let ariaHiddenElements = 0;
    let textNodes = 0;
    const hiddenRoots: Element[] = [];
    for (const [index, node] of originals.entries()) {
      if (index === 0) continue;
      const original = originalByClone.get(node);
      if (!original) continue;
      const style = getComputedStyle(original);
      const hidden = style.display === "none" || style.visibility === "hidden"
        || style.visibility === "collapse" || style.opacity === "0" || original.hidden;
      if (hidden) {
        hiddenElements += 1;
        if (!hiddenRoots.some(parent => parent.contains(original))) {
          hiddenRoots.push(original);
          hiddenTextChars += (node.textContent ?? "").length;
        }
        visibleNodes[index]?.remove();
      }
      if (original.getAttribute("contenteditable") === "false") nonEditableElements += 1;
      if (original.getAttribute("aria-hidden") === "true") ariaHiddenElements += 1;
    }
    ariaVisible.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
    editable.querySelectorAll('[contenteditable="false"]').forEach(node => node.remove());
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    while (walker.nextNode()) textNodes += 1;
    return {
      text, rawText: element.textContent ?? "", visibleText: read(visible),
      ariaVisibleText: read(ariaVisible), editableText: read(editable), innerText: element.innerText,
      structure: {
        hiddenTextChars, hiddenElements, nonEditableElements, ariaHiddenElements, textNodes,
        elements: originals.length, paragraphs: element.querySelectorAll("p, div, pre").length,
        lineBreaks: element.querySelectorAll("br").length, markdownEditor,
        connectorSelected: hasConnectorPill, spans: element.querySelectorAll("span").length,
        links: element.querySelectorAll("a").length, codeElements: element.querySelectorAll("code").length,
        mathElements: element.querySelectorAll("math, [data-lexical-math]").length,
      },
    };
  };

  const clone = element.cloneNode(true) as HTMLElement;
  const originalNodes = diagnostic ? [element, ...element.querySelectorAll<HTMLElement>("*")] : [];
  const clonedNodes = diagnostic ? [clone, ...clone.querySelectorAll<HTMLElement>("*")] : [];
  const originalByClone = new Map(clonedNodes.map((node, index) => [node, originalNodes[index]!]));
  const markdownEditor = element.hasAttribute("data-composer-markdown");
  const connectorBlock = clone.querySelector(
    '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]',
  )?.closest("p, div");
  const hasConnectorPill = clone.querySelector(
    '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]',
  ) != null;
  // ChatGPT hydrates decorative accessibility-excluded nodes after insertion.
  // Their text (for example icon/style scaffolding) is not authored draft text.
  // Keep explicitly editable islands and all ordinary noneditable token labels.
  // Whole-prompt verification still rejects any loss or real mutation afterward.
  clone.querySelectorAll<HTMLElement>('[aria-hidden="true"]').forEach(node => {
    if (node.getAttribute("contenteditable") !== "true"
      && !node.querySelector('[contenteditable="true"]')) node.remove();
  });
  clone.querySelectorAll(
    '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]',
  )
    .forEach(part => part.remove());
  // The connector path inserts one separator ahead of the prompt. Remove only that
  // text code unit before reconstructing lines, so a separator-only text node cannot
  // contribute an extra line. Never trim the prompt's own leading whitespace.
  if (hasConnectorPill) {
    const walker = clone.ownerDocument.createTreeWalker(clone, 4 /* SHOW_TEXT */);
    let first = walker.nextNode();
    while (first && !first.textContent) first = walker.nextNode();
    if (first?.textContent?.startsWith(" ") || first?.textContent?.startsWith("\u00A0")) {
      first.textContent = first.textContent!.slice(1);
      if (!first.textContent) first.parentNode?.removeChild(first);
    }
    // A leading line break can leave the mention in its own empty block,
    // followed by the actual prompt's BR. The mention's block boundary is
    // UI scaffolding, not a second newline in the prompt.
    if (connectorBlock && connectorBlock !== clone && !connectorBlock.hasChildNodes()
      && connectorBlock.nextElementSibling?.firstChild?.nodeName === "BR") {
      connectorBlock.remove();
    }
  }
  // Lexical can split a line into several inline spans, or put BRs inside a
  // paragraph. textContent joined per child invents lines in the former case
  // and loses them in the latter. Decode structural line breaks explicitly.
  const blocks = new Set(["DIV", "P", "PRE", "BLOCKQUOTE", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const read = (parent: Node): string => {
    const nodes = [...parent.childNodes];
    if ((parent === clone || blocks.has(parent.nodeName))
      && nodes.length === 1 && nodes[0]!.nodeName === "BR") return "";
    const parts = nodes.map(node => ({
      text: node.nodeType === 3 ? node.textContent ?? ""
        : node.nodeName === "BR" ? "\n" : read(node),
      block: blocks.has(node.nodeName),
      br: node.nodeName === "BR",
    })).filter(part => part.block || part.text.length > 0);
    // Chromium uses a final BR to make the end caret visible; a real trailing
    // newline has a further empty paragraph or an additional BR before it.
    // The markdown composer retains meaningful final BRs; unlike the older
    // contenteditable, it does not append a caret BR after inserted text.
    if (!markdownEditor && (parent === clone || blocks.has(parent.nodeName)) && parts.at(-1)?.br) parts.pop();
    return parts.map((part, index) => (
      index > 0 && (part.block || parts[index - 1]!.block) ? "\n" : ""
    ) + part.text).join("");
  };
  const text = read(clone);
  if (!diagnostic) return text;
  return inspect(text, clone, read);

}
