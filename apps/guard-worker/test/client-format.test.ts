import { describe, expect, it } from "vitest";
import { normalizeNumericDraft } from "../src/client/format.js";

describe("budget number entry", () => {
  it("removes integer leading zeroes while preserving valid decimals", () => {
    expect(normalizeNumericDraft("010")).toBe("10");
    expect(normalizeNumericDraft("0010")).toBe("10");
    expect(normalizeNumericDraft("00.5")).toBe("0.5");
    expect(normalizeNumericDraft("0.5")).toBe("0.5");
    expect(normalizeNumericDraft("0")).toBe("0");
    expect(normalizeNumericDraft("")).toBe("");
  });
});
