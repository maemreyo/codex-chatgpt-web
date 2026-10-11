import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  CHATGPT_IDLE_OBSERVATION_RECHECK_MS,
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  ChatGptBrowserWorker,
  ChatGptSubmittedTurnIdleRecovery,
  ChatGptTurnDomHealthTracker,
  MAX_CHATGPT_IDLE_OBSERVATION_RECOVERIES,
} from "../src/adapters/chatgpt-web/browser-worker";

test("ambiguous idle re-observes an accepted response twice before reporting the existing error", async () => {
  const health = new ChatGptTurnDomHealthTracker(20, 10, 30);
  const recovery = new ChatGptSubmittedTurnIdleRecovery();
  const idle = {
    responsePresent: true, running: false, currentText: "",
    completionActionVisible: false, externalProgressLive: false,
  };
  const observations: number[] = [];
  const observeExistingTurn = async (attempt: number) => { observations.push(attempt); };

  expect(health.update(idle, 0)).toBeUndefined();
  const error = health.update(idle, 30);
  expect(error).toContain("idle timeout");
  expect(await recovery.retry(error, idle, observeExistingTurn)).toBeTrue();
  expect(await recovery.retry(health.update(idle, 31), idle, observeExistingTurn)).toBeTrue();
  expect(await recovery.retry(health.update(idle, 32), idle, observeExistingTurn)).toBeFalse();
  expect(health.update(idle, 600_000)).toBe(error);
  expect(observations).toEqual([1, 2]);
  expect(MAX_CHATGPT_IDLE_OBSERVATION_RECOVERIES).toBe(2);

  // A confirmed empty completion cannot be retried or described as a successful answer.
  const completedEmpty = { ...idle, completionActionVisible: true };
  expect(health.update(completedEmpty, 600_011)).toBeUndefined();
  const completedError = health.update(completedEmpty, 600_021);
  expect(completedError).toContain("completed without a final answer");
  expect(await recovery.retry(completedError, completedEmpty, observeExistingTurn)).toBeFalse();
  expect(observations).toEqual([1, 2]);
});

test("an accepted assistant turn is recovered by fresh observation without another Send", async () => {
  type Baseline = { initialTurnIdentities: string[]; domCache: { key?: string; snapshot?: unknown } };
  type State = { turnIdentities: string[]; userIdentities: string[]; responseIdentities: string[]; visibleStopButtonCount: number };
  type Binding = { identity: string; locator: unknown; acceptedTurnIdentities: string[] };
  const hidden = { filter() { return this; }, last() { return this; }, isVisible: async () => false };
  const assistant = { boundTo: "submitted-assistant" };
  const page = {
    isClosed: () => false,
    locator: (selector: string) => selector.startsWith("[data-turn-id=") ? assistant : hidden,
  } as unknown as Page;
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    waitForNewAssistantTurn(page: Page, baseline: Baseline, deadline: number | undefined,
      signal?: AbortSignal, progress?: unknown, graceMs?: number, tracker?: unknown,
      recovery?: (attempt: number, cause: Error, baseline: Baseline) => Promise<{ page: Page; baseline: Baseline }>): Promise<Binding>;
    submissionDomState(page: Page, cache: Baseline["domCache"]): Promise<State>;
    waitForTurnDomOrExternalProgress(): Promise<void>;
  };
  const originalNow = Date.now;
  try {
    for (const outcome of ["late-assistant", "never-arrives"] as const) {
      let now = 1_000;
      let waits = 0;
      let observations = 0;
      let rebinding = 0;
      const baseline: Baseline = { initialTurnIdentities: [], domCache: {} };
      Date.now = () => now;
      worker.submissionDomState = async (_page, cache) => {
        expect(cache).toBe(baseline.domCache);
        observations += 1;
        return {
          turnIdentities: ["submitted-user", "submitted-assistant"],
          userIdentities: ["submitted-user"],
          responseIdentities: outcome === "late-assistant" && rebinding === 1
            ? ["submitted-assistant"] : [],
          visibleStopButtonCount: 0,
        };
      };
      worker.waitForTurnDomOrExternalProgress = async () => {
        waits += 1;
        // One original DOM grace followed by at most two short bounded refresh intervals.
        now += (waits === 1 ? CHATGPT_RESPONSE_DOM_GRACE_MS : CHATGPT_IDLE_OBSERVATION_RECHECK_MS) + 1;
        if (waits > 3) throw new Error("unbounded assistant observation wait");
      };
      const result = worker.waitForNewAssistantTurn(
        page, baseline, undefined, undefined, undefined, CHATGPT_RESPONSE_DOM_GRACE_MS,
        undefined, async (attempt, cause, receivedBaseline) => {
          expect(attempt).toBe(MAX_CHATGPT_IDLE_OBSERVATION_RECOVERIES);
          expect(cause.message).toContain("Accepted assistant turn was not visible");
          expect(receivedBaseline).toBe(baseline);
          rebinding += 1;
          // Refresh the existing page and baseline. This fixture has no composer or Send surface.
          return { page, baseline };
        },
      );
      if (outcome === "late-assistant") {
        await expect(result).resolves.toEqual({
          identity: "submitted-assistant", locator: assistant,
          acceptedTurnIdentities: ["submitted-user", "submitted-assistant"],
        });
        expect(waits).toBe(2);
      } else {
        await expect(result).rejects.toThrow("did not expose its assistant turn in the DOM");
        expect(waits).toBe(3);
      }
      expect(rebinding).toBe(1);
      // Each refresh immediately re-reads once, then polls during its bounded interval.
      expect(observations).toBe(outcome === "late-assistant" ? 5 : 6);
      expect(now).toBe(1_000 + CHATGPT_RESPONSE_DOM_GRACE_MS + 1
        + (outcome === "late-assistant" ? 1 : 2) * (CHATGPT_IDLE_OBSERVATION_RECHECK_MS + 1));
    }
  } finally {
    Date.now = originalNow;
  }
});
