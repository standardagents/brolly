import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BrollyConfig { guardUrl: string; accountId: string; adminToken: string; installedAt: number }
const directory = join(homedir(), ".brolly");
const path = join(directory, "config.json");

export async function loadConfig(): Promise<BrollyConfig> {
  return JSON.parse(await readFile(path, "utf8")) as BrollyConfig;
}

export async function saveConfig(config: BrollyConfig): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
