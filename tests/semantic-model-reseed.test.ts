import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatGptSemanticEpochStore, type StoredChatGptSemanticEpochV1 } from "../src/adapters/chatgpt-web/semantic-epoch-store";

function epoch(semanticEpoch: number, modelFamily: string): StoredChatGptSemanticEpochV1 {
  return {
    version: 1,
    projectionPolicyVersion: 1,
    digestPolicyVersion: 1,
    threadId: "thread",
    semanticEpoch,
    sourceTurnId: "turn",
    sourceAnswerHash: "answer",
    sourceUserRevisionHash: "user",
    coveredThroughRef: "ref",
    coveredHistoryDigest: "digest",
    modelFamily,
    tier: 0,
    maskingPolicyVersion: 1,
    artifactLedger: { filesTouched: [], commands: [], testOutcomes: [] },
    updatedAt: semanticEpoch,
  };
}

test("same source under a new model family reseeds instead of becoming an idempotent replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-reseed-"));
  try {
    const store = new ChatGptSemanticEpochStore(join(dir, "state.json"), () => 10);
    expect(store.commit(epoch(1, "5.6"), { verifiedAuthority: true }).committed).toBeTrue();
    const reseed = store.commit(epoch(2, "6"), { expectedSemanticEpoch: 1 });
    expect(reseed).toMatchObject({ committed: true, idempotent: false });
    expect(reseed.record.modelFamily).toBe("6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
