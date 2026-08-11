import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react(), cloudflare({ configPath: "../../wrangler.jsonc" })],
  build: { rollupOptions: { output: { assetFileNames: "assets/[name][extname]" } } },
  server: { port: 5173, strictPort: true },
  ssr: { noExternal: ["@standardagents/brolly-core", "@standardagents/brolly-notifiers", "@standardagents/brolly-runtime"] },
});
