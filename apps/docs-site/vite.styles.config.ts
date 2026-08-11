import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    outDir: "dist/server",
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/styles.css"),
      output: {
        assetFileNames: "styles.css",
        entryFileNames: "styles-entry.js",
      },
    },
  },
});
