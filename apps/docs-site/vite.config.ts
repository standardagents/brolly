import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    ssr: "src/render.tsx",
    outDir: "dist/server",
    emptyOutDir: true,
    minify: true,
  },
});
