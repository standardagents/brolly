import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "src/render.tsx",
    outDir: "dist/server",
    emptyOutDir: true,
    minify: true,
  },
});
