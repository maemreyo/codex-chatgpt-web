import { expect, test } from "bun:test";
import { semanticValidationReason } from "../src/adapters/chatgpt-web/semantic-log";

test("known semantic validation categories remain distinct from operational unknowns", () => {
  expect(semanticValidationReason(new Error("digest mismatch"))).toBe("digest_mismatch");
  expect(semanticValidationReason(new Error("anchor is missing"))).toBe("anchor_missing");
  expect(semanticValidationReason(new Error("crosses the covered-history cut"))).toBe("cross_boundary");
  expect(semanticValidationReason(new Error("invalid epoch records"))).toBe("schema");
  expect(semanticValidationReason(new Error("invalid JSON"))).toBe("corrupt_store");
  expect(semanticValidationReason(new Error("private disk I/O failure"))).toBe("operational_unknown");
  expect(semanticValidationReason({ secret: "private token" })).toBe("operational_unknown");
});
