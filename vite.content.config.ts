import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Dedicated build for the MV3 content script.
//
// MV3 content_scripts are CLASSIC scripts: they cannot contain top-level
// import/export and cannot reference a separately emitted runtime chunk.
// The main build (vite.config.ts) therefore only emits the module entries
// (panel + background); this config emits js/content.js as a self-contained
// IIFE with no imports, no exports, and no chunk dependencies.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./extension/src", import.meta.url)),
    },
  },
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    target: "es2018",
    sourcemap: false,
    minify: "esbuild",
    rollupOptions: {
      input: "extension/src/content/main.ts",
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "js/content.js",
        assetFileNames: "assets/[name]-[hash][extname]",
        plugins: [
          {
            name: "content-classic-wrap",
            renderChunk(code) {
              // Rollup hoists namespace-interop helpers (__defProp & co.) BEFORE the
              // IIFE it generates for format:"iife". Inside a classic script those
              // top-level `var`s would leak onto window. Wrap the WHOLE emitted
              // chunk (prelude + inner IIFE) in one strict IIFE so nothing escapes.
              let out = code;
              // The entry declares `export {};` — drop standalone export statements.
              out = out.replace(/export\s*\{[^}]*\}\s*;?/g, "");
              const stray = /(^|[\n;])\s*(import|export)\s/.test(out);
              if (stray) {
                throw new Error("content build output still contains import/export after wrap");
              }
              return `(function(){\n"use strict";\n${out}\n})();\n`;
            },
          },
        ],
      },
    },
  },
});