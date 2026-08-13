import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Client bundle for the prerendered site: builds index.html with hashed
// script/style assets so the page hydrates in production. The prerender
// script injects the server-rendered markup into this build's index.html.
// public/ is copied by the prerender script (it needs dereference for the
// symlinked icon directories), so it is disabled here.
export default defineConfig({
  plugins: [tailwindcss()],
  publicDir: false,
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    minify: true,
  },
});
