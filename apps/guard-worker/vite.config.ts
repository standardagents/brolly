import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
// @ts-expect-error -- plain-JS module shared with the template scripts
import { templateRelease } from "../../scripts/template-release.mjs";

// Baked from the last commit that touched a template input, not the build
// HEAD, so rebuilding an unchanged worker reproduces the same bytes.
const release: string = templateRelease(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));

export default defineConfig(({ command }) => {
  // A caller's development NODE_ENV must not leak React's development transform,
  // absolute source paths, or jsxDEV helpers into the published deploy template.
  if (command === "build") process.env.NODE_ENV = "production";

  const accountDevelopment = command === "serve" && process.env.BROLLY_ACCOUNT_DEV === "1";
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const allowedHosts = ["macbookserver.tail13bd39.ts.net", ".trycloudflare.com"];
  const accountDevelopmentPort = Number(process.env.BROLLY_DEV_PORT);

  return {
    define: { __BROLLY_RELEASE__: JSON.stringify(release) },
    plugins: [tailwindcss(), react(), cloudflare({
      configPath: "../../wrangler.jsonc",
      persistState: accountDevelopment ? { path: path.join(repositoryRoot, ".wrangler/state/account-dev") } : undefined,
      remoteBindings: accountDevelopment ? false : undefined,
      tunnel: accountDevelopment ? { autoStart: true } : undefined,
    })],
    build: { rollupOptions: { output: { assetFileNames: "assets/[name][extname]" } } },
    server: {
      port: accountDevelopment && Number.isInteger(accountDevelopmentPort) && accountDevelopmentPort > 0 ? accountDevelopmentPort : 5173,
      strictPort: true,
      host: accountDevelopment ? process.env.BROLLY_DEV_HOST ?? "0.0.0.0" : undefined,
      allowedHosts,
    },
    preview: { allowedHosts },
    ssr: { noExternal: ["@standardagents/brolly-core", "@standardagents/brolly-notifiers", "@standardagents/brolly-runtime"] },
  };
});
