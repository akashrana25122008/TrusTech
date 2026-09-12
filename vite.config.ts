/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./extension/src", import.meta.url)),
    },
  },
  publicDir: "extension/public",
  build: {
    outDir: "dist",
    target: "es2020",
    sourcemap: false,
    rollupOptions: {
      input: {
        panel: "extension/panel.html",
        background: "extension/src/background/main.ts",
      },
      output: {
        entryFileNames: "js/[name].js",
        chunkFileNames: "js/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    // DOM tests (grounder/indexer/observer/executor) need a browser-like env.
    environment: "jsdom",
  },
});