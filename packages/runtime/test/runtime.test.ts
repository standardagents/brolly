import { describe, expect, it } from "vitest";
import {
  BrollyQuarantinedError,
  brollyDurableObject,
  brollyWorker,
  readBrollyFuse,
  type BrollyFuseManifest,
} from "../src/index.js";

const objectId = "a".repeat(64);
const otherId = "b".repeat(64);
const quarantine = { actionId: "action-1", incidentId: "incident-1", reason: "Rows read emergency", appliedAt: 100 };

function env(manifest: BrollyFuseManifest | string): { BROLLY_FUSE: string } {
  return { BROLLY_FUSE: typeof manifest === "string" ? manifest : JSON.stringify(manifest) };
}

describe("Brolly runtime fuse", () => {
  it("passes without performing work when no valid explicit quarantine exists", () => {
    expect(() => brollyWorker({})).not.toThrow();
    expect(() => brollyWorker(env("not json"))).not.toThrow();
    expect(readBrollyFuse(env("not json"))).toBeNull();
  });

  it("stops an entire Worker", () => {
    expect(() => brollyWorker(env({ version: 1, generation: 2, worker: quarantine }))).toThrowError(BrollyQuarantinedError);
  });

  it("stops only the exact Durable Object ID", () => {
    const fuse = env({ version: 1, generation: 3, objects: { [objectId]: quarantine } });
    expect(() => brollyWorker(fuse, { durableObjectId: otherId })).not.toThrow();
    expect(() => brollyWorker(fuse, { durableObjectId: objectId })).toThrowError(BrollyQuarantinedError);
    expect(() => brollyDurableObject({ id: { toString: () => otherId } }, fuse)).not.toThrow();
    expect(() => brollyDurableObject({ id: { toString: () => objectId } }, fuse)).toThrowError(BrollyQuarantinedError);
  });

  it("passes an expired quarantine without needing a deployment at the expiry instant", () => {
    const fuse = env({ version: 1, generation: 4, objects: { [objectId]: { ...quarantine, expiresAt: 500 } } });
    expect(() => brollyDurableObject({ id: { toString: () => objectId } }, fuse, 500)).not.toThrow();
  });
});
