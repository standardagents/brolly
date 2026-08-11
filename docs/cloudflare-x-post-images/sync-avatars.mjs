import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(sourceDirectory, "..", "..");
const stories = JSON.parse(await readFile(join(sourceDirectory, "posts.json"), "utf8"));

for (const story of stories) {
  const output = join(repositoryRoot, "apps", "docs-site", "public", story.avatarFile);
  await mkdir(dirname(output), { recursive: true });
  const response = await fetch(story.avatar);
  if (!response.ok) throw new Error(`Could not fetch ${story.slug} avatar (${response.status})`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) throw new Error(`${story.slug} avatar was not an image`);
  await writeFile(output, new Uint8Array(await response.arrayBuffer()));
  console.log(`Updated ${story.avatarFile}`);
}
