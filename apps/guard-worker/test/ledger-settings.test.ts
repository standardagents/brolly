import { describe, expect, it } from "vitest";
import { DEFAULT_LEDGER_RUN_LIMITS, validateLedgerRunLimits } from "../src/ledger-settings.js";

describe("configurable ledger run limits", () => {
  it("accepts complete positive limits within every product ceiling", () => {
    expect(validateLedgerRunLimits(DEFAULT_LEDGER_RUN_LIMITS)).toBeNull();
  });

  it("rejects missing, unknown, invalid, and excessive values", () => {
    expect(validateLedgerRunLimits({})).toContain("graphqlQueries");
    expect(validateLedgerRunLimits({ ...DEFAULT_LEDGER_RUN_LIMITS, retries: 0 })).toContain("positive integer");
    expect(validateLedgerRunLimits({ ...DEFAULT_LEDGER_RUN_LIMITS, graphqlQueries: 501 })).toContain("cannot exceed");
    expect(validateLedgerRunLimits({ ...DEFAULT_LEDGER_RUN_LIMITS, surprise: 1 })).toContain("Unknown");
  });
});
