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
      launcher(semantic({ event: "semantic_reject", threadHash: threadA, class: "D" })),
      launcher(semantic({ event: "semantic_reject", threadHash: threadA, class: "D" })),
      launcher(semantic({ event: "semantic_fallback", threadHash: threadA, to: "legacy" })),
      launcher(semantic({ event: "semantic_skip", threadHash: "SECRET TRANSCRIPT CONTENT", reason: "SECRET TRANSCRIPT CONTENT" })),
      launcher(semantic({ event: "semantic_reject", threadHash: "SECRET TRANSCRIPT CONTENT", class: "SECRET TRANSCRIPT CONTENT" })),
      JSON.stringify({ at: "x", level: "info", event: "runtime.stdout", detail: { line: "SECRET TRANSCRIPT CONTENT" } }),
    ].join("\n"), "utf8");

    const report = semanticLogReport(path);
    expect(report.events).toBe(11);
    expect(report.threads).toBe(2);
    expect(report.turns).toBe(3);
    expect(report.rotations).toBe(1);
    expect(report.maskedTokensSaved).toBe(900);
    expect(report.skipsByReason).toEqual({ ineligible: 1, no_fit: 1, unknown: 1 });
    expect(report.rejectionsByClass).toEqual({ D: 2, unknown: 1 });
    expect(report.rejectionsAfterRotation).toBe(2);
    expect(report.fallbacksByTarget).toEqual({ legacy: 1 });
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
