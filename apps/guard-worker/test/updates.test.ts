import { describe, expect, it } from "vitest";
import { parseReleaseManifest, validRepository } from "../src/updates.js";

const validManifest = {
  schemaVersion: 1,
  release: "a".repeat(40),
  displayVersion: "2026.08.12-aaaaaaa",
  publishedAt: "2026-08-12T12:00:00.000Z",
  notesUrl: `https://github.com/standardagents/brolly/commit/${"a".repeat(40)}`,
  workflowFile: "brolly-update.yml",
  configVersion: 1,
};

describe("Brolly release metadata", () => {
  it("accepts only the fixed release format and trusted notes location", () => {
    expect(parseReleaseManifest(validManifest)).toEqual(validManifest);
    expect(() => parseReleaseManifest({ ...validManifest, release: "main" })).toThrow("identifier");
    expect(() => parseReleaseManifest({ ...validManifest, notesUrl: "https://example.com/update" })).toThrow("not trusted");
    expect(() => parseReleaseManifest({ ...validManifest, workflowFile: "other.yml" })).toThrow("unsupported");
  });

  it("accepts public and private GitHub repository slugs without accepting URLs", () => {
    expect(validRepository("standardagents/brolly-guard")).toBe(true);
    expect(validRepository("Acme_Inc/private.brolly")).toBe(true);
    expect(validRepository("https://github.com/acme/brolly")).toBe(false);
    expect(validRepository("acme/brolly/actions")).toBe(false);
    expect(validRepository("../brolly")).toBe(false);
  });
});
