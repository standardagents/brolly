import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertDemoLoopbackPortAvailable } from "../vite.demo.config";

let listener: Server | null = null;

afterEach(async () => {
  if (!listener) return;
  const current = listener;
  listener = null;
  await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
});

describe("demo port ownership", () => {
  it("rejects an existing IPv4 loopback listener", async () => {
    const port = await listen("127.0.0.1");
    await expect(assertDemoLoopbackPortAvailable(port)).rejects.toThrow(`occupied on 127.0.0.1`);
  });

  it("rejects an existing IPv6 loopback listener", async () => {
    const port = await listen("::1");
    await expect(assertDemoLoopbackPortAvailable(port)).rejects.toThrow(`occupied on ::1`);
  });
});

async function listen(host: "127.0.0.1" | "::1"): Promise<number> {
  listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener!.once("error", reject);
    listener!.listen({ host, port: 0, exclusive: true }, resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener address");
  return address.port;
}
