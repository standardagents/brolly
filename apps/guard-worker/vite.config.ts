import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

const release = process.env.GITHUB_SHA
  ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

export default defineConfig(({ command }) => {
  // A caller's development NODE_ENV must not leak React's development transform,
  // absolute source paths, or jsxDEV helpers into the published deploy template.
  if (command === "build") process.env.NODE_ENV = "production";

  return {
    define: { __BROLLY_RELEASE__: JSON.stringify(release) },
    plugins: [tailwindcss(), react(), cloudflare({ configPath: "../../wrangler.jsonc" })],
    build: { rollupOptions: { output: { assetFileNames: "assets/[name][extname]" } } },
    server: { port: 5173, strictPort: true },
    ssr: { noExternal: ["@standardagents/brolly-core", "@standardagents/brolly-notifiers", "@standardagents/brolly-runtime"] },
  };
});
