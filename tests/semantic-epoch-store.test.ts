import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    digestPolicyVersion: 1,
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
