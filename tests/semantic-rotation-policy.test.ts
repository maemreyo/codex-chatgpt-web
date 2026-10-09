import { expect, test } from "bun:test";
import { decideSemanticEpochRotation } from "../src/adapters/chatgpt-web/semantic-rotation-policy";

const safe = {
  occupancyConfidence: "known" as const,
  occupancyTokens: 15_000,
  nextMessageTokens: 1_000,
  physicalLimit: 111_193,
  incrementalSavingsTokens: 1_000,
};

test("reuse a healthy, low-pressure epoch without spending another rotation", () => {
  expect(decideSemanticEpochRotation(safe)).toBe("reuse");
  expect(decideSemanticEpochRotation({ ...safe, incrementalSavingsTokens: 8_192 })).toBe("token_savings");
  expect(decideSemanticEpochRotation({ ...safe, occupancyTokens: 70_000 })).toBe("physical_pressure");
});

test("unknown occupancy, rejected capacity or insufficient reserve never justify reuse", () => {
  expect(decideSemanticEpochRotation({ ...safe, occupancyConfidence: "unknown" })).toBe("unknown_occupancy");
  expect(decideSemanticEpochRotation({ ...safe, occupancyTokens: null })).toBe("unknown_occupancy");
  expect(decideSemanticEpochRotation({ ...safe, physicalLimit: 12_288 })).toBe("physical_pressure");
});
