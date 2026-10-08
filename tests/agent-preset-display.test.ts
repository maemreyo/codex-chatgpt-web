import { expect, test } from "bun:test";
import { presetFromThreadLimit } from "../launcher/src/AgentManagerPanel";

test("preset shown on reopen follows the persisted native child-thread limit", () => {
  expect(presetFromThreadLimit(6)).toBe("parallel");
  expect(presetFromThreadLimit(4)).toBe("balanced");
  expect(presetFromThreadLimit(null)).toBe("balanced");
  expect(presetFromThreadLimit(3)).toBe("custom");
  expect(presetFromThreadLimit(8)).toBe("custom");
});
