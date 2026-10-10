import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import {
  ChatGptSemanticEpochStore,
  validateSemanticEpochRecord,
  type StoredChatGptSemanticEpochV1,
} from "../src/adapters/chatgpt-web/semantic-epoch-store";
import { parseRequest } from "../src/responses/parser";
import { semanticCoveredHistoryDigest } from "../src/responses/semantic-provenance";
import { renderSemanticArtifactLedger } from "../src/responses/semantic-provenance";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";

function parsed(threadId = "thread_a") {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId,
        turn_id: "turn_2",
        request_kind: "turn",
      }),
    },
    input: [
      { type: "message", role: "user", content: "first", internal_chat_message_metadata_passthrough: { turn_id: "turn_1" } },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }], internal_chat_message_metadata_passthrough: { turn_id: "turn_1" } },
      { type: "message", role: "user", content: "next", internal_chat_message_metadata_passthrough: { turn_id: "turn_2" } },
    ],
  });
}

function epoch(
  semanticEpoch: number,
  sourceTurnId: string,
  updatedAt: number,
  overrides: Partial<StoredChatGptSemanticEpochV1> = {},
): StoredChatGptSemanticEpochV1 {
  const request = parsed();
  const coveredThroughRef = request._semanticProvenance!.items[1]!.ref;
  return {
    version: 1,
    projectionPolicyVersion: 1,
    digestPolicyVersion: 3,
    threadId: "thread_a",
    semanticEpoch,
    sourceTurnId,
    sourceAnswerHash: `answer_${sourceTurnId}`,
    sourceUserRevisionHash: `user_${sourceTurnId}`,
    coveredThroughRef,
    coveredHistoryDigest: semanticCoveredHistoryDigest(request._semanticProvenance!, coveredThroughRef),
    modelFamily: "5.6",
    tier: 0,
    maskingPolicyVersion: 1,
    artifactLedger: { filesTouched: [], commands: [], testOutcomes: [] },
    updatedAt,
    ...overrides,
  };
}

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), "semantic-epoch-store-"));
  return { dir, path: join(dir, "semantic-epochs.json") };
}

/** A directory at the target path makes atomic rename fail deterministically. */
function expectFailedPersist(path: string, action: () => unknown): void {
  const savedPath = `${path}.saved`;
  renameSync(path, savedPath);
  mkdirSync(path);
  try {
    expect(action).toThrow();
  } finally {
    rmdirSync(path);
    renameSync(savedPath, path);
  }
}

test("semantic epoch commits are durable, idempotent and fenced against delayed older completions", () => {
  const { dir, path } = tempState();
  try {
    const store = new ChatGptSemanticEpochStore(path, () => 1000);
    const first = epoch(1, "turn_1", 1000);
    expect(store.commit(first, { verifiedAuthority: true })).toMatchObject({ committed: true, idempotent: false });
    expect(store.commit(first, { expectedSemanticEpoch: 0 })).toMatchObject({ committed: false, idempotent: true });

    const winner = epoch(2, "turn_2a", 1001);
    expect(store.commit(winner, { expectedSemanticEpoch: 1 })).toMatchObject({ committed: true, idempotent: false });
    const delayed = epoch(2, "turn_2b", 1002);
    expect(() => store.commit(delayed, { expectedSemanticEpoch: 1 })).toThrow("commit fence changed");
    expect(store.get("thread_a")?.sourceTurnId).toBe("turn_2a");

    const reloaded = new ChatGptSemanticEpochStore(path, () => 1002);
    expect(reloaded.get("thread_a")).toEqual(winner);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("separate instances do not overwrite another thread after loading stale state", () => {
  const { dir, path } = tempState();
  try {
    const first = new ChatGptSemanticEpochStore(path, () => 1002);
    const second = new ChatGptSemanticEpochStore(path, () => 1002);
    expect(first.get("thread_a")).toBeUndefined();
    expect(second.get("thread_a")).toBeUndefined();

    const a = epoch(1, "turn_a", 1000);
    const b = epoch(1, "turn_b", 1001, { threadId: "thread_b" });
    first.commit(a, { verifiedAuthority: true });
    second.commit(b, { verifiedAuthority: true });
    const fresh = new ChatGptSemanticEpochStore(path, () => 1002);
    expect(fresh.get("thread_a")).toEqual(a);
    expect(fresh.get("thread_b")).toEqual(b);
    expect(first.get("thread_b")).toEqual(b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delayed cross-instance commit cannot resurrect a quarantined epoch", () => {
  const { dir, path } = tempState();
  try {
    const owner = new ChatGptSemanticEpochStore(path, () => 1002);
    const delayed = new ChatGptSemanticEpochStore(path, () => 1002);
    const first = epoch(1, "turn_1", 1000);
    owner.commit(first, { verifiedAuthority: true });
    expect(delayed.get("thread_a")).toEqual(first);
    expect(owner.quarantineIfCurrent("thread_a", first, "digest_mismatch")).toBe(true);

    const next = epoch(2, "turn_2", 1001);
    expect(() => delayed.commit(next, { expectedSemanticEpoch: 1 })).toThrow("quarantined");
    const fresh = new ChatGptSemanticEpochStore(path, () => 1002);
    expect(fresh.isQuarantined("thread_a")).toBe(true);
    expect(fresh.get("thread_a")).toBeUndefined();
    expect(delayed.isQuarantined("thread_a")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a quarantined epoch reopens only after a completed compaction is replayed as native v2 history", () => {
  const { dir, path } = tempState();
  try {
    const writer = new ChatGptSemanticEpochStore(path, () => 1002);
    const reader = new ChatGptSemanticEpochStore(path, () => 1002);
    const first = epoch(1, "turn_1", 1000);
    writer.commit(first, { verifiedAuthority: true });
    expect(writer.quarantineIfCurrent("thread_a", first, "anchor_missing")).toBeTrue();
    const fence = writer.quarantineFence("thread_a");
    expect(fence).toBeDefined();

    const compact = (value: string) => [{ type: "compaction", encrypted_content: encodeCompactionSummary(value) }];
    const summary = "This native compact was completed after the invalid epoch";
    expect(reader.acceptCompletedCompaction("thread_a", compact(summary))).toBeFalse();
    expect(writer.rememberCompletedCompaction("thread_a", fence, summary)).toBeTrue();
    expect(reader.acceptCompletedCompaction("thread_a", compact("Unrelated summary"))).toBeFalse();
    expect(reader.acceptCompletedCompaction("thread_a", [...compact(summary), ...compact("Newer unrelated compact")])).toBeFalse();
    expect(reader.acceptCompletedCompaction("thread_a", [{ type: "message", role: "user",
      content: `${SUMMARY_PREFIX}\n${summary}` }])).toBeFalse();
    expect(reader.isQuarantined("thread_a")).toBeTrue();
    expect(reader.acceptCompletedCompaction("thread_a", compact(summary))).toBeTrue();
    expect(new ChatGptSemanticEpochStore(path, () => 1002).isQuarantined("thread_a")).toBeFalse();
    expect(reader.acceptCompletedCompaction("thread_a", compact(summary))).toBeFalse();
    // A clean canonical post-compaction history can now establish a fresh epoch.
    expect(writer.commit(epoch(1, "post_compact", 1002), { verifiedAuthority: true }).committed).toBeTrue();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale or failed compaction cannot clear a newer quarantine", () => {
  const { dir, path } = tempState();
  try {
    const store = new ChatGptSemanticEpochStore(path, () => 1002);
    const first = epoch(1, "turn_1", 1000);
    store.commit(first, { verifiedAuthority: true });
    const capturedBeforeInvalidation = store.quarantineFence("thread_a");
    expect(capturedBeforeInvalidation).toBeUndefined();
    store.quarantineIfCurrent("thread_a", first, "digest_mismatch");
    expect(store.rememberCompletedCompaction("thread_a", capturedBeforeInvalidation, "old summary")).toBeFalse();
    const fence = store.quarantineFence("thread_a");
    expect(store.rememberCompletedCompaction("thread_a", fence, "")).toBeFalse();
    expect(store.acceptCompletedCompaction("thread_a", [{ type: "compaction",
      encrypted_content: encodeCompactionSummary("old summary") }])).toBeFalse();
    expect(store.isQuarantined("thread_a")).toBeTrue();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-instance completions CAS on the pending digest and accept a fresh-fence successor", () => {
  const { dir, path } = tempState();
  try {
    const firstProcess = new ChatGptSemanticEpochStore(path, () => 1002);
    const secondProcess = new ChatGptSemanticEpochStore(path, () => 1002);
    const first = epoch(1, "turn_1", 1000);
    firstProcess.commit(first, { verifiedAuthority: true });
    expect(firstProcess.quarantineIfCurrent("thread_a", first, "anchor_missing")).toBeTrue();
    const firstFence = firstProcess.quarantineFence("thread_a");
    const staleFence = secondProcess.quarantineFence("thread_a");
    expect(staleFence).toBe(firstFence);

    expect(firstProcess.rememberCompletedCompaction("thread_a", firstFence, "first summary")).toBeTrue();
    const afterFirst = readFileSync(path, "utf8");
    expect(secondProcess.rememberCompletedCompaction("thread_a", staleFence, "first summary")).toBeTrue();
    expect(secondProcess.rememberCompletedCompaction("thread_a", staleFence, "delayed different summary")).toBeFalse();
    expect(readFileSync(path, "utf8")).toBe(afterFirst);

    // Starts after A completed and reloads the durable pending digest as a new fence.
    const thirdProcess = new ChatGptSemanticEpochStore(path, () => 1002);
    const successorFence = thirdProcess.quarantineFence("thread_a");
    expect(successorFence).toBeDefined();
    expect(successorFence).not.toBe(firstFence);
    expect(thirdProcess.rememberCompletedCompaction("thread_a", successorFence, "successor summary")).toBeTrue();
    const afterSuccessor = readFileSync(path, "utf8");
    expect(thirdProcess.rememberCompletedCompaction("thread_a", successorFence, "successor summary")).toBeTrue();
    expect(readFileSync(path, "utf8")).toBe(afterSuccessor);
    expect(firstProcess.rememberCompletedCompaction("thread_a", firstFence, "first summary")).toBeFalse();
    expect(secondProcess.acceptCompletedCompaction("thread_a", [{
      type: "compaction",
      encrypted_content: encodeCompactionSummary("first summary"),
    }])).toBeFalse();
    expect(new ChatGptSemanticEpochStore(path, () => 1002).isQuarantined("thread_a")).toBeTrue();
    expect(new ChatGptSemanticEpochStore(path, () => 1002).acceptCompletedCompaction("thread_a", [{
      type: "compaction",
      encrypted_content: encodeCompactionSummary("successor summary"),
    }])).toBeTrue();
    expect(new ChatGptSemanticEpochStore(path, () => 1002).isQuarantined("thread_a")).toBeFalse();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successor completions preserve the original 30-day quarantine TTL", () => {
  const { dir, path } = tempState();
  try {
    let now = 1002;
    const store = new ChatGptSemanticEpochStore(path, () => now);
    const first = epoch(1, "turn_1", 1000);
    store.commit(first, { verifiedAuthority: true });
    expect(store.quarantineIfCurrent("thread_a", first, "anchor_missing")).toBeTrue();
    const oldFence = store.quarantineFence("thread_a");
    expect(store.rememberCompletedCompaction("thread_a", oldFence, "old summary")).toBeTrue();

    now += 29 * 24 * 60 * 60_000;
    const second = new ChatGptSemanticEpochStore(path, () => now);
    const current = second.quarantineFence("thread_a");
    expect(current).not.toBe(oldFence);
    expect(second.rememberCompletedCompaction("thread_a", current, "new summary")).toBeTrue();
    const persisted = readFileSync(path, "utf8");
    expect(JSON.parse(persisted).quarantines.thread_a.updatedAt).toBe(1002);
    now += 2 * 24 * 60 * 60_000;
    expect(new ChatGptSemanticEpochStore(path, () => now).isQuarantined("thread_a")).toBeFalse();
    expect(readFileSync(path, "utf8")).toBe(persisted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy pending compact without captured fence remains retryable after restart", () => {
  const { dir, path } = tempState();
  try {
    const writer = new ChatGptSemanticEpochStore(path, () => 1002);
    const first = epoch(1, "turn_1", 1000);
    writer.commit(first, { verifiedAuthority: true });
    expect(writer.quarantineIfCurrent("thread_a", first, "anchor_missing")).toBeTrue();
    const oldFence = writer.quarantineFence("thread_a");
    expect(writer.rememberCompletedCompaction("thread_a", oldFence, "legacy summary")).toBeTrue();

    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.quarantines.thread_a.pendingCompactionCaptureFence;
    writeFileSync(path, JSON.stringify(legacy));
    const restarted = new ChatGptSemanticEpochStore(path, () => 1002);
    const persisted = readFileSync(path, "utf8");
    expect(restarted.rememberCompletedCompaction("thread_a", oldFence, "legacy summary")).toBeTrue();
    expect(readFileSync(path, "utf8")).toBe(persisted);
    const successorFence = restarted.quarantineFence("thread_a");
    expect(successorFence).not.toBe(oldFence);
    expect(restarted.rememberCompletedCompaction("thread_a", successorFence, "new summary")).toBeTrue();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale cross-instance validator cannot quarantine a newer committed epoch", () => {
  const { dir, path } = tempState();
  try {
    const validator = new ChatGptSemanticEpochStore(path, () => 1002);
    const writer = new ChatGptSemanticEpochStore(path, () => 1002);
    const first = epoch(1, "turn_1", 1000);
    validator.commit(first, { verifiedAuthority: true });
    const observed = validator.get("thread_a")!;
    expect(writer.get("thread_a")).toEqual(first);
    const successor = epoch(2, "turn_2", 1001);
    writer.commit(successor, { expectedSemanticEpoch: 1 });

    expect(validator.quarantineIfCurrent("thread_a", observed, "anchor_missing")).toBe(false);
    expect(new ChatGptSemanticEpochStore(path, () => 1002).get("thread_a")).toEqual(successor);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another process's epoch-store lock fails closed without changing durable state", () => {
  const { dir, path } = tempState();
  try {
    const store = new ChatGptSemanticEpochStore(path, () => 1002);
    const active = epoch(1, "turn_1", 1000);
    store.commit(active, { verifiedAuthority: true });
    const before = readFileSync(path, "utf8");
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath);
    try {
      const delayed = new ChatGptSemanticEpochStore(path, () => 1002);
      expect(() => delayed.commit(epoch(2, "turn_2", 1001), { expectedSemanticEpoch: 1 }))
        .toThrow("locked or unavailable");
      expect(() => delayed.quarantineIfCurrent("thread_a", active, "anchor_missing"))
        .toThrow("locked or unavailable");
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      rmdirSync(lockPath);
    }
    expect(store.quarantineIfCurrent("thread_a", active, "anchor_missing")).toBe(true);
    expect(new ChatGptSemanticEpochStore(path, () => 1002).isQuarantined("thread_a")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verified corrupt-file recovery requires the same exclusive lock", () => {
  const { dir, path } = tempState();
  try {
    writeFileSync(path, "{broken", "utf8");
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath);
    try {
      expect(() => new ChatGptSemanticEpochStore(path).get("thread_a", true))
        .toThrow("locked or unavailable");
      expect(readFileSync(path, "utf8")).toBe("{broken");
      expect(readdirSync(dir).filter(name => name.includes(".corrupt-"))).toHaveLength(0);
    } finally {
      rmdirSync(lockPath);
    }
    expect(new ChatGptSemanticEpochStore(path).get("thread_a", true)).toBeUndefined();
    expect(readdirSync(dir).filter(name => name.includes(".corrupt-"))).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quarantine fences the full active identity and leaves a superseding epoch intact", () => {
  const { dir, path } = tempState();
  try {
    const store = new ChatGptSemanticEpochStore(path, () => 1002);
    const first = epoch(1, "turn_1", 1000);
    store.commit(first, { verifiedAuthority: true });
    const observed = store.get("thread_a")!;

    // A delayed validation of epoch 1 must not quarantine epoch 2.
    const successor = epoch(2, "turn_2", 1001);
    store.commit(successor, { expectedSemanticEpoch: 1 });
    const saved = readFileSync(path, "utf8");
    expect(store.quarantineIfCurrent("thread_a", observed, "anchor_missing")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(saved);

    // Same epoch number but a different source digest, anchor, timestamp or
    // ledger is also a stale observation, even if the numeric fence matches.
    for (const changed of [
      { sourceAnswerHash: "changed" },
      { sourceUserRevisionHash: "changed" },
      { coveredHistoryDigest: "changed" },
      { coveredThroughRef: "changed" },
      { updatedAt: 1002 },
      { artifactLedger: { filesTouched: [], commands: [], testOutcomes: [{ failed: false, ref: "extra" }] } },
    ]) {
      expect(store.quarantineIfCurrent("thread_a", { ...successor, ...changed }, "anchor_missing")).toBe(false);
    }
    expect(store.get("thread_a")).toEqual(successor);
    expect(readFileSync(path, "utf8")).toBe(saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quarantine is durable, idempotent and rejects delayed commits or replay after restart", () => {
  const { dir, path } = tempState();
  try {
    const store = new ChatGptSemanticEpochStore(path, () => 1001);
    const active = epoch(1, "turn_1", 1000);
    expect(store.isQuarantined("thread_a")).toBe(false);
    store.commit(active, { verifiedAuthority: true });
    expect(store.isQuarantined("thread_a")).toBe(false);
    expect(store.quarantineIfCurrent("thread_a", { ...active, threadId: "other" }, "anchor_missing")).toBe(false);
    expect(store.quarantineIfCurrent("thread_a", store.get("thread_a")!, "anchor_missing")).toBe(true);
    expect(store.get("thread_a")).toBeUndefined();
    expect(store.isQuarantined("thread_a")).toBe(true);
    expect(store.isQuarantined("thread_b")).toBe(false);
    const persisted = readFileSync(path, "utf8");
    const file = JSON.parse(persisted);
    expect(file.epochs.thread_a).toBeUndefined();
    expect(file.quarantines.thread_a).toMatchObject({
      semanticEpoch: 1, reason: "anchor_missing", updatedAt: 1001,
    });
    expect(file.quarantines.thread_a.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted).not.toContain('"sourceAnswerHash"');

    expect(store.quarantineIfCurrent("thread_a", active, "anchor_missing")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(persisted);
    for (const retry of [active, epoch(1, "replayed", 1002), epoch(2, "later", 1002)]) {
      let error: unknown;
      try { store.commit(retry, { expectedSemanticEpoch: retry.semanticEpoch - 1, verifiedAuthority: true }); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ChatGptWebAdapterError);
      expect((error as ChatGptWebAdapterError).code).toBe("semantic_epoch_quarantined");
    }
    const restarted = new ChatGptSemanticEpochStore(path, () => 1002);
    expect(restarted.get("thread_a")).toBeUndefined();
    expect(restarted.isQuarantined("thread_a")).toBe(true);
    expect(() => restarted.commit(active, { verifiedAuthority: true })).toThrow("quarantined");
    expect(readFileSync(path, "utf8")).toBe(persisted);

    // Quarantine is scoped to this thread. Other canonical threads can rotate.
    const other = epoch(1, "other", 1002, { threadId: "thread_b" });
    expect(restarted.commit(other, { verifiedAuthority: true }).committed).toBe(true);
    expect(new ChatGptSemanticEpochStore(path, () => 1002).get("thread_b")).toEqual(other);
    expect(new ChatGptSemanticEpochStore(path, () => 1002).get("thread_a")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quarantine blocks new canonical source turns until expiry; checking it never writes", () => {
  const { dir, path } = tempState();
  try {
    let now = 1000;
    const store = new ChatGptSemanticEpochStore(path, () => now);
    const active = epoch(1, "turn_1", 1000);
    store.commit(active, { verifiedAuthority: true });
    expect(store.quarantineIfCurrent("thread_a", active, "anchor_missing")).toBe(true);
    const state = readFileSync(path, "utf8");
    const freshTurn = epoch(1, "genuine_turn_3", 1001);
    expect(() => store.commit(freshTurn, { verifiedAuthority: true }))
      .toThrow("quarantined");
    expect(store.isQuarantined("thread_a")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(state);

    // Epoch identity has no independently validated reset path: the bounded
    // 30-day store TTL is the only automatic release from quarantine.
    now += 31 * 24 * 60 * 60_000;
    expect(store.isQuarantined("thread_a")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(state);
    const refreshed = epoch(1, "genuine_turn_3", now);
    expect(store.commit(refreshed, { verifiedAuthority: true }).committed).toBe(true);
    expect(store.get("thread_a")).toEqual(refreshed);
    expect(new ChatGptSemanticEpochStore(path, () => now).isQuarantined("thread_a")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed persistence does not change cached epochs or quarantine status", () => {
  const { dir, path } = tempState();
  try {
    const store = new ChatGptSemanticEpochStore(path, () => 1002);
    const active = epoch(1, "turn_1", 1000);
    store.commit(active, { verifiedAuthority: true });
    const before = readFileSync(path, "utf8");
    const successor = epoch(2, "turn_2", 1001);
    expectFailedPersist(path, () => store.commit(successor, { expectedSemanticEpoch: 1 }));
    expect(store.get("thread_a")).toEqual(active);
    expect(store.isQuarantined("thread_a")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);

    expectFailedPersist(path, () => store.quarantineIfCurrent("thread_a", active, "anchor_missing"));
    expect(store.get("thread_a")).toEqual(active);
    expect(store.isQuarantined("thread_a")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);

    // A failed commit must not make the next valid sequence conflict.
    expect(store.commit(successor, { expectedSemanticEpoch: 1 }).committed).toBe(true);
    expect(store.quarantineIfCurrent("thread_a", active, "anchor_missing")).toBe(false);
    expect(store.quarantineIfCurrent("thread_a", successor, "anchor_missing")).toBe(true);
    expect(store.isQuarantined("thread_a")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tampered quarantine entries fail closed and preserve persisted state", () => {
  for (const quarantine of [
    { semanticEpoch: 1, identityDigest: "invalid", reason: "anchor_missing", updatedAt: 1000 },
    { semanticEpoch: 1, identityDigest: "a".repeat(64), reason: "unbounded raw error", updatedAt: 1000 },
  ]) {
    const { dir, path } = tempState();
    try {
      const source = JSON.stringify({ version: 1, epochs: {}, quarantines: { thread_a: quarantine } });
      writeFileSync(path, source);
      expect(() => new ChatGptSemanticEpochStore(path, () => 1000).get("thread_a", true))
        .toThrow("semantic epoch file");
      expect(readFileSync(path, "utf8")).toBe(source);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("invalid JSON is preserved only on independently verified recovery", () => {
  const { dir, path } = tempState();
  try {
    writeFileSync(path, "{broken", "utf8");
    const unverified = new ChatGptSemanticEpochStore(path);
    let observed: unknown;
    try { unverified.get("thread_a"); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(ChatGptWebAdapterError);
    expect((observed as ChatGptWebAdapterError).code).toBe("semantic_epoch_state_invalid");
    expect(readFileSync(path, "utf8")).toBe("{broken");

    const verified = new ChatGptSemanticEpochStore(path);
    expect(verified.get("thread_a", true)).toBeUndefined();
    expect(readdirSync(dir).filter(name => name.startsWith("semantic-epochs.json.corrupt-"))).toHaveLength(1);
    expect(() => readFileSync(path, "utf8")).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted legacy ledgers remain readable without claiming success from failed=false", () => {
  const { dir, path } = tempState();
  try {
    const legacy = epoch(1, "turn_1", 1000, {
      artifactLedger: {
        filesTouched: [],
        commands: [{ commandDigest: "abc", failed: false, ref: "ci1_old_1" }],
        testOutcomes: [{ failed: false, ref: "ci1_old_1" }],
      },
    });
    const source = JSON.stringify({ version: 1, epochs: { thread_a: legacy } });
    writeFileSync(path, source, "utf8");
    const restored = new ChatGptSemanticEpochStore(path, () => 1000).get("thread_a")!;
    expect(restored.artifactLedger.commands[0]?.status).toBeUndefined();
    expect(restored.artifactLedger.testOutcomes[0]?.status).toBeUndefined();
    expect(renderSemanticArtifactLedger(restored.artifactLedger)).toContain("legacy rows without status as unverified");
    expect(readFileSync(path, "utf8")).toBe(source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy digest policy remains verifiable without silently migrating its evidence", () => {
  const request = parsed();
  const legacy = epoch(1, "turn_1", 1000, {
    digestPolicyVersion: 1,
    coveredHistoryDigest: semanticCoveredHistoryDigest(request._semanticProvenance!, request._semanticProvenance!.items[1]!.ref, 1),
  });
  expect(() => validateSemanticEpochRecord(request, legacy, { modelFamily: "5.6" })).not.toThrow();
  const v2 = epoch(1, "turn_1", 1000, {
    digestPolicyVersion: 2,
    coveredHistoryDigest: semanticCoveredHistoryDigest(request._semanticProvenance!, request._semanticProvenance!.items[1]!.ref, 2),
  });
  expect(() => validateSemanticEpochRecord(request, v2, { modelFamily: "5.6" })).not.toThrow();
});

test("contradictory persisted ledger outcomes fail closed without overwriting state", () => {
  const { dir, path } = tempState();
  try {
    const invalid = epoch(1, "turn_1", 1000, {
      artifactLedger: {
        filesTouched: [],
        commands: [{ commandDigest: "abc", failed: true, status: "success", ref: "ci1_old_1" }],
        testOutcomes: [],
      },
    });
    const source = JSON.stringify({ version: 1, epochs: { thread_a: invalid } });
    writeFileSync(path, source, "utf8");
    expect(() => new ChatGptSemanticEpochStore(path, () => 1000).get("thread_a"))
      .toThrow("semantic epoch file");
    expect(readFileSync(path, "utf8")).toBe(source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsupported schema and invalid records fail closed without overwrite or rename", () => {
  for (const payload of [
    { version: 2, epochs: {} },
    { version: 1, epochs: { thread_a: { nope: true } } },
  ]) {
    const { dir, path } = tempState();
    try {
      const source = `${JSON.stringify(payload)}\n`;
      writeFileSync(path, source, "utf8");
      const store = new ChatGptSemanticEpochStore(path);
      expect(() => store.get("thread_a", true)).toThrow("semantic epoch file");
      expect(readFileSync(path, "utf8")).toBe(source);
      expect(readdirSync(dir).filter(name => name.includes(".corrupt-"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("epoch validation rejects changed prefix, wrong thread/model family and missing pin refs", () => {
  const request = parsed();
  const base = epoch(1, "turn_1", 1000);
  expect(() => validateSemanticEpochRecord(request, base, { modelFamily: "5.6" })).not.toThrow();

  expect(() => validateSemanticEpochRecord(parsed("thread_other"), base, { modelFamily: "5.6" }))
    .toThrow("thread mismatch");
  expect(() => validateSemanticEpochRecord(request, base, { modelFamily: "6" }))
    .toThrow("model-family mismatch");

  const changed = parseRequest({
    ...(request._rawBody as Record<string, unknown>),
    input: [
      { type: "message", role: "user", content: "changed", internal_chat_message_metadata_passthrough: { turn_id: "turn_1" } },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }], internal_chat_message_metadata_passthrough: { turn_id: "turn_1" } },
      { type: "message", role: "user", content: "next", internal_chat_message_metadata_passthrough: { turn_id: "turn_2" } },
    ],
  });
  expect(() => validateSemanticEpochRecord(changed, base, { modelFamily: "5.6" }))
    .toThrow("digest mismatch");

  const tierOne: StoredChatGptSemanticEpochV1 = {
    ...base,
    tier: 1,
    checkpoint: {
      version: 1,
      objective: "objective",
      decisions: [],
      ruledOut: [],
      unresolved: [],
      nextActions: [],
      notes: "notes",
      pinRefs: ["ci1_missing_1"],
    },
  };
  expect(() => validateSemanticEpochRecord(request, tierOne, { modelFamily: "5.6" }))
    .toThrow("checkpoint pin is missing");
});

test("expired epochs do not survive reload", () => {
  const { dir, path } = tempState();
  try {
    const store = new ChatGptSemanticEpochStore(path, () => 1);
    store.commit(epoch(1, "turn_1", 1), { verifiedAuthority: true });
    const later = new ChatGptSemanticEpochStore(path, () => 31 * 24 * 60 * 60_000);
    expect(later.get("thread_a")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
