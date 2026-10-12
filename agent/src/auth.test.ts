import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeEqual } from "./auth.js";

describe("safeEqual", () => {
  it("matches equal secrets of any length", () => {
    assert.equal(safeEqual("short", "short"), true);
    assert.equal(safeEqual("a-much-longer-token-value", "a-much-longer-token-value"), true);
  });

  it("rejects unequal secrets without length early-return path", () => {
    assert.equal(safeEqual("abc", "abcd"), false);
    assert.equal(safeEqual("token-a", "token-b"), false);
  });
});
