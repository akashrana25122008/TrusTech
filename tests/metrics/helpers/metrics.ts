import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface PrResult {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export function pr(tp: number, fp: number, fn: number): PrResult {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

export interface Distribution {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

export function describe(values: number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.length > 0 ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  return {
    n: s.length,
    min: s.length > 0 ? s[0] : 0,
    median: quantile(s, 0.5),
    p95: quantile(s, 0.95),
    max: s.length > 0 ? s[s.length - 1] : 0,
    mean,
  };
}

export function wilson(p: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function spanIou(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const inter = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  return union > 0 ? inter / union : 0;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boxIou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

export function boxCovers(inner: Box, outer: Box): number {
  const x0 = Math.max(inner.x, outer.x);
  const y0 = Math.max(inner.y, outer.y);
  const x1 = Math.min(inner.x + inner.width, outer.x + outer.width);
  const y1 = Math.min(inner.y + inner.height, outer.y + outer.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = inner.width * inner.height;
  return area > 0 ? inter / area : 0;
}

const REPORTS_DIR = resolve(process.cwd(), "tests/metrics/reports");

export function recordFragment(name: string, data: unknown): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = resolve(REPORTS_DIR, `fragment-${name}.json`);
  let existing: unknown = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    existing = {};
  }
  void existing;
  writeFileSync(path, JSON.stringify({ name, recordedAt: new Date().toISOString(), data }, null, 2) + "\n");
  return path;
}

export function reportsDir(): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  return REPORTS_DIR;
}

export function round1(v: number): number {
  return Math.round(v * 1000) / 10;
}

export function pct(fraction0to1: number): number {
  return Math.round(fraction0to1 * 1000) / 10;
}

export function envInfo(): Record<string, string> {
  const out: Record<string, string> = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown",
  };
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
    out.vitest = String(pkg.devDependencies?.vitest ?? "unknown");
    out.transformers = String(pkg.dependencies?.["@huggingface/transformers"] ?? "unknown");
  } catch {
    out.vitest = "unknown";
  }
  return out;
}
