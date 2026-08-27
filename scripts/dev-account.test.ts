import { describe, expect, it, vi } from "vitest";
import { credentialKeyIsValid, findAvailablePort, scheduleMinuteCron, upsertCredentialKey } from "./dev-account.mjs";

const KEY = "A".repeat(43);

describe("real-account local development", () => {
  it("creates one valid credential key without changing other local variables", () => {
    const next = upsertCredentialKey("EXISTING=value\nBROLLY_CREDENTIAL_KEY=\n", () => KEY);

    expect(next).toEqual({
      contents: `EXISTING=value\nBROLLY_CREDENTIAL_KEY=${KEY}\n`,
      generated: true,
    });
    expect(credentialKeyIsValid(KEY)).toBe(true);
  });

  it("preserves a configured credential key and rejects invalid key material", () => {
    expect(upsertCredentialKey(`BROLLY_CREDENTIAL_KEY=${KEY}\n`, () => "unused")).toEqual({
      contents: `BROLLY_CREDENTIAL_KEY=${KEY}\n`,
      generated: false,
    });
    expect(() => upsertCredentialKey("BROLLY_CREDENTIAL_KEY=short\n")).toThrow("256-bit base64 or base64url");
  });

  it("drives the production scheduled handler on a minute cadence", async () => {
    let now = 61_000;
    const fetchImpl = vi.fn(async () => {
      now += 55_000;
      return new Response("{}");
    });
    const timers: Array<() => Promise<void>> = [];
    const setTimer = vi.fn((callback: () => Promise<void>) => {
      timers.push(callback);
      return timers.length;
    });
    const clearTimer = vi.fn();
    const scheduler = scheduleMinuteCron("http://100.64.0.1:5173", {
      fetchImpl,
      now: () => now,
      setTimer,
      clearTimer,
      log: vi.fn(),
      warn: vi.fn(),
    });

    expect(setTimer).toHaveBeenNthCalledWith(1, expect.any(Function), 59_000);
    await timers[0]!();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://100.64.0.1:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&format=json");
    expect(setTimer).toHaveBeenNthCalledWith(2, expect.any(Function), 4_000);

    scheduler.stop();
    expect(clearTimer).toHaveBeenCalledWith(2);
  });

  it("selects an available ephemeral port for the account development server", async () => {
    const port = await findAvailablePort("127.0.0.1");

    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
    expect(port).not.toBe(5173);
  });
});
