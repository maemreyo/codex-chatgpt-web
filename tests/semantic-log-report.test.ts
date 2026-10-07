import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { semanticLogReport } from "../scripts/semantic-log-report";

test("semantic log report reads raw and launcher-wrapped events without surfacing content", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-log-report-"));
  const path = join(dir, "launcher.jsonl");
  try {
    const semantic = (event: Record<string, unknown>) => JSON.stringify(event);
    const launcher = (line: string) => JSON.stringify({
      at: "2026-10-08T00:00:00Z",
      level: "info",
      event: "runtime.stdout",
      detail: { line },
    });
    writeFileSync(path, [
      semantic({ event: "semantic_turn", threadHash: "aaa", epoch: 1 }),
      launcher(semantic({ event: "semantic_turn", threadHash: "aaa", epoch: 1 })),
      launcher(semantic({ event: "semantic_rotation", threadHash: "aaa", maskedTokensEst: 900 })),
      launcher(semantic({ event: "semantic_turn", threadHash: "aaa", epoch: 2 })),
      launcher(semantic({ event: "semantic_skip", threadHash: "bbb", reason: "ineligible" })),
      launcher(semantic({ event: "semantic_reject", threadHash: "aaa", class: "D" })),
      launcher(semantic({ event: "semantic_fallback", threadHash: "aaa", to: "legacy" })),
      JSON.stringify({ at: "x", level: "info", event: "runtime.stdout", detail: { line: "SECRET TRANSCRIPT CONTENT" } }),
    ].join("\n"), "utf8");

    const report = semanticLogReport(path);
    expect(report.events).toBe(7);
    expect(report.threads).toBe(2);
    expect(report.turns).toBe(3);
    expect(report.rotations).toBe(1);
    expect(report.maskedTokensSaved).toBe(900);
    expect(report.skipsByReason).toEqual({ ineligible: 1 });
    expect(report.rejectionsByClass).toEqual({ D: 1 });
    expect(report.rejectionsAfterRotation).toBe(1);
    expect(report.fallbacksByTarget).toEqual({ legacy: 1 });
    expect(report.slowestStepsPerTurnThreads[0]).toMatchObject({
      threadHash: "aaa",
      turns: 2,
      averageStepsPerTurn: 1.5,
      maxStepsPerTurn: 2,
    });
    expect(JSON.stringify(report)).not.toContain("SECRET TRANSCRIPT CONTENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
