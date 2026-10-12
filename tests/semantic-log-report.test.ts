import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { semanticLogReport } from "../scripts/semantic-log-report";

test("semantic log report reads raw and launcher-wrapped events without surfacing content", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-log-report-"));
  const path = join(dir, "launcher.jsonl");
  try {
    const threadA = "aaaaaaaaaaaaaaaa";
    const threadB = "bbbbbbbbbbbbbbbb";
    const semantic = (event: Record<string, unknown>) => JSON.stringify(event);
    const launcher = (line: string) => JSON.stringify({
      at: "2026-10-08T00:00:00Z",
      level: "info",
      event: "runtime.stdout",
      detail: { line },
    });
    writeFileSync(path, [
      semantic({ event: "semantic_turn", threadHash: threadA, epoch: 1 }),
      launcher(semantic({ event: "semantic_turn", threadHash: threadA, epoch: 1 })),
      launcher(semantic({ event: "semantic_rotation", threadHash: threadA, maskedTokensEst: 900 })),
      launcher(semantic({ event: "semantic_turn", threadHash: threadA, epoch: 2 })),
      launcher(semantic({ event: "semantic_skip", threadHash: threadB, reason: "ineligible" })),
      launcher(semantic({ event: "semantic_skip", threadHash: threadA, reason: "no_fit" })),
      launcher(semantic({ event: "semantic_validation_failed", threadHash: threadA, reason: "digest_mismatch" })),
      launcher(semantic({ event: "semantic_validation_failed", threadHash: threadB, reason: "SECRET TRANSCRIPT CONTENT" })),
      launcher(semantic({ event: "semantic_reject", threadHash: threadA, class: "D" })),
      launcher(semantic({ event: "semantic_reject", threadHash: threadA, class: "D" })),
      launcher(semantic({ event: "semantic_fallback", threadHash: threadA,
        to: "legacy", reason: "rotation_first_message_no_fit" })),
      launcher(semantic({ event: "semantic_fallback", threadHash: threadB,
        to: "legacy", reason: "SECRET TRANSCRIPT CONTENT" })),
      launcher(semantic({ event: "semantic_cost", threadHash: threadA,
        legacyEquivalentSubmissions: 2, checkpointTailRequests: 1,
        checkpointTailTokensEst: 30, epochRotations: 1, reseedInputTokensEst: 650,
        webCompactionSubmissions: 1, extraStageSubmissions: 0, discardedTails: 0 })),
      launcher(semantic({ event: "semantic_cost", threadHash: threadB,
        legacyEquivalentSubmissions: 1, checkpointTailRequests: 0,
        checkpointTailTokensEst: 0, epochRotations: 0, reseedInputTokensEst: 0,
        webCompactionSubmissions: 0, extraStageSubmissions: 0, discardedTails: 0 })),
      launcher(semantic({ event: "semantic_cost", threadHash: threadA,
        legacyEquivalentSubmissions: "SECRET TRANSCRIPT CONTENT", checkpointTailRequests: 30 })),
      launcher(semantic({ event: "semantic_skip", threadHash: "SECRET TRANSCRIPT CONTENT", reason: "SECRET TRANSCRIPT CONTENT" })),
      launcher(semantic({ event: "semantic_reject", threadHash: "SECRET TRANSCRIPT CONTENT", class: "SECRET TRANSCRIPT CONTENT" })),
      JSON.stringify({ at: "x", level: "info", event: "runtime.stdout", detail: { line: "SECRET TRANSCRIPT CONTENT" } }),
    ].join("\n"), "utf8");

    const report = semanticLogReport(path);
    expect(report.events).toBe(17);
    expect(report.threads).toBe(2);
    expect(report.turns).toBe(3);
    expect(report.rotations).toBe(1);
    expect(report.maskedTokensSaved).toBe(900);
    expect(report.loggedCost).toEqual({
      samples: 2, legacyEquivalentSubmissions: 3, checkpointTailRequests: 1,
      checkpointTailTokensEst: 30, epochRotations: 1, reseedInputTokensEst: 650,
      webCompactionSubmissions: 1, extraStageSubmissions: 0, discardedTails: 0,
      additionalSubmissionsPer100Legacy: 200 / 3,
    });
    expect(report.skipsByReason).toEqual({ ineligible: 1, no_fit: 1, unknown: 1 });
    expect(report.validationFailuresByReason).toEqual({ digest_mismatch: 1, unknown: 1 });
    expect(report.rejectionsByClass).toEqual({ D: 2, unknown: 1 });
    expect(report.rejectionsAfterRotation).toBe(2);
    expect(report.fallbacksByTarget).toEqual({ legacy: 2 });
    expect(report.fallbacksByReason).toEqual({ rotation_first_message_no_fit: 1, unknown: 1 });
    expect(report.retainedRejectionSignals).toEqual({
      total: 2,
      repeatedByThread: [{ threadHash: threadA, rejections: 2 }],
      rotationPreflightNoFit: 1,
    });
    expect(report.epochReuseByThread[0]).toMatchObject({
      threadHash: threadA,
      observedEpochs: 2,
      semanticTurns: 3,
      averageTurnsPerEpoch: 1.5,
      maxTurnsPerEpoch: 2,
    });
    expect(JSON.stringify(report)).not.toContain("SECRET TRANSCRIPT CONTENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotated logs are combined before per-thread ratios, epoch reuse and cost are computed", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-rotated-report-"));
  const older = join(dir, "launcher.jsonl.1");
  const newer = join(dir, "launcher.jsonl");
  const threadHash = "cccccccccccccccc";
  const cost = (legacyEquivalentSubmissions: number, epochRotations: number) => ({
    event: "semantic_cost", threadHash, legacyEquivalentSubmissions,
    checkpointTailRequests: 0, checkpointTailTokensEst: 0, epochRotations,
    reseedInputTokensEst: epochRotations * 500, webCompactionSubmissions: 0,
    extraStageSubmissions: 0, discardedTails: 0,
  });
  try {
    writeFileSync(older, [
      { event: "semantic_turn", threadHash, epoch: 1 },
      { event: "semantic_rotation", threadHash, maskedTokensEst: 240 },
      cost(1, 1),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(newer, [
      { event: "semantic_turn", threadHash, epoch: 2 },
      { event: "semantic_reject", threadHash, class: "D" },
      cost(2, 0),
      { event: "semantic_skip", reason: "SECRET RAW PROMPT" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");

    const report = semanticLogReport([older, newer]);
    expect(report.events).toBe(7);
    expect(report.threads).toBe(1);
    expect(report.turns).toBe(2);
    expect(report.rotations).toBe(1);
    expect(report.rejectionsAfterRotation).toBe(1);
    expect(report.maskedTokensSaved).toBe(240);
    expect(report.loggedCost).toMatchObject({
      samples: 2, legacyEquivalentSubmissions: 3, epochRotations: 1,
      reseedInputTokensEst: 500, additionalSubmissionsPer100Legacy: 0,
    });
    expect(report.epochReuseByThread[0]).toMatchObject({
      threadHash, observedEpochs: 2, semanticTurns: 2,
      averageTurnsPerEpoch: 1,
    });
    expect(semanticLogReport([older, older, newer])).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("SECRET RAW PROMPT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
