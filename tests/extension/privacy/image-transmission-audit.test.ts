import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * Phase 3 §17 + §37 — static transmission-path audit, enforced as a
 * test. EVERY network sink in extension/src must be allowlisted here
 * with a justification. A new fetch/WebSocket/XHR/FormData call site
 * fails this test until it is reviewed and routed through a gate.
 * ------------------------------------------------------------------ */

const SRC = resolve(process.cwd(), "extension/src");

interface Sink {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function allTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allTs(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const SINK_RES = [
  { kind: "fetch", re: /\bfetch\s*\(/ },
  { kind: "fetch-ref", re: /globalThis\.fetch/ },
  { kind: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
  { kind: "WebSocket", re: /\bnew\s+WebSocket\s*\(/ },
  { kind: "EventSource", re: /\bnew\s+EventSource\s*\(/ },
  { kind: "FormData-upload", re: /\bnew\s+FormData\s*\(/ },
  { kind: "sendBeacon", re: /\.sendBeacon\s*\(/ },
];

/** Allowlisted sinks: file → justification. Everything else FAILS. */
const ALLOWLIST: Array<{ file: string; kinds: string[]; why: string }> = [
  {
    file: "extension/src/llm/gateway-provider.ts",
    kinds: ["fetch", "fetch-ref"],
    why: "sanctioned text sender: JSON /api/agent/step + /health through TransmissionFirewall (blocks RAW_IMAGE); payload schema has no image fields",
  },
  {
    file: "extension/src/vision/capture.ts",
    kinds: ["fetch"],
    why: "local-only fetch(dataUrl): decodes the capture into RGBA in-memory; never a network URL, never leaves the device",
  },
  {
    file: "extension/src/privacy/image-gate.ts",
    kinds: ["fetch", "fetch-ref"],
    why: "sanctioned artifact-level image sender: sealed SanitizedImage + validated manifest only; every other shape BLOCKs before fetch",
  },
  {
    file: "extension/src/privacy/visual-transmission.ts",
    kinds: ["fetch-ref"],
    why: "THE authoritative pipeline-level image sender: live TransmissionPermit + sealed bytes + manifest + metadata; permit revalidated per attempt; default transport is injectable for tests",
  },
];

function findSinks(): Sink[] {
  const sinks: Sink[] = [];
  for (const file of allTs(SRC)) {
    const rel = relative(resolve(process.cwd()), file);
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((text, i) => {
      const stripped = text.trim();
      if (stripped.startsWith("*") || stripped.startsWith("//")) return; // comments
      for (const { kind, re } of SINK_RES) {
        if (re.test(text)) sinks.push({ file: rel, line: i + 1, kind, text: stripped.slice(0, 120) });
      }
    });
  }
  return sinks;
}

describe("image-transmission-audit (static)", () => {
  it("every network sink is allowlisted with a justification", () => {
    const sinks = findSinks();
    const violations = sinks.filter(
      (s) => !ALLOWLIST.some((a) => s.file === a.file && a.kinds.includes(s.kind)),
    );
    expect(
      violations.map((v) => `${v.file}:${v.line} [${v.kind}] ${v.text}`),
      "unreviewed network sink — route it through a gate or allowlist it",
    ).toEqual([]);
  });

  it("the allowlist only names files that still exist and still contain the sink", () => {
    const sinks = findSinks();
    for (const a of ALLOWLIST) {
      const hits = sinks.filter((s) => s.file === a.file && a.kinds.includes(s.kind));
      expect(hits.length, `allowlist entry ${a.file} [${a.kinds}] matches no sink — remove it`).toBeGreaterThan(0);
    }
  });

  it("exactly four sanctioned senders exist (no sender sprawl)", () => {
    expect(ALLOWLIST).toHaveLength(4);
  });

  it("no raw capture API is reachable from sender modules", () => {
    const senders = [
      "extension/src/llm/gateway-provider.ts",
      "extension/src/privacy/image-gate.ts",
      "extension/src/privacy/visual-transmission.ts",
      "extension/src/privacy/transmission-permit.ts",
    ];
    for (const rel of senders) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf-8");
      expect(src.includes("captureVisibleTab"), `${rel} must not capture`).toBe(false);
      expect(src.includes("captureActiveTab"), `${rel} must not capture`).toBe(false);
    }
  });

  it("capture and vision modules never import the senders (capture ≠ network, §28)", () => {
    const producers = [
      "extension/src/vision/capture.ts",
      "extension/src/vision/vision-worker-client.ts",
      "extension/src/vision/worker/vision-engine.ts",
      "extension/src/vision/worker/vision.worker.ts",
    ];
    for (const rel of producers) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf-8");
      expect(src.includes("image-gate"), `${rel} must not import the image gate`).toBe(false);
      expect(src.includes("visual-transmission"), `${rel} must not import the sender`).toBe(false);
      expect(src.includes("transmission-permit"), `${rel} must not import permits`).toBe(false);
    }
  });

  it("sender modules expose no raw-send escape hatch", () => {
    for (const rel of ["extension/src/privacy/image-gate.ts", "extension/src/privacy/visual-transmission.ts"]) {
      const raw = readFileSync(resolve(process.cwd(), rel), "utf-8");
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      expect(code, rel).not.toMatch(/sendRaw|sendImage\s*\(|postRaw|uploadRaw/);
    }
  });
});
