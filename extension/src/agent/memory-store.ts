/* ------------------------------------------------------------------ *
 * VisualMemoryStore — local persistence + read/write pipelines for
 * Feature #5. The store orchestrates; all semantics live in
 * visual-memory.ts (pure). Storage failures NEVER fail the task:
 * every backend call is guarded, corruption discards, absence means
 * fresh perception.
 *
 * No network here — backends are chrome.storage.local (real sessions)
 * or in-memory (tests / fallback). Nothing leaves the device.
 * ------------------------------------------------------------------ */

import { rawApi } from "@/shared/runtime";
import {
  MEMORY_LIMITS,
  extractSemanticFacts,
  extractRegionOrder,
  extractInteractionPatterns,
  shouldPersistCandidate,
  sanitizeCandidate,
  isKnownFact,
  newMemory,
  mergeMemory,
  enforceRetention,
  relevanceScore,
  checkCompatibility,
  effectiveConfidence,
  freshnessOf,
  memoryContextLines,
  type VisualMemory,
  type MemoryQuery,
  type RetrievalResult,
  type SemanticFact,
} from "./visual-memory";
export type { RetrievalResult };
import type { AgentAction } from "@/shared/action-schema";
import type { ObservationSnapshot } from "@/shared/messages";
import type { TaskIntent } from "./task-intent";

export interface MemoryStorage {
  load(): Promise<unknown>;
  save(data: unknown): Promise<boolean>;
  clear(): Promise<void>;
}

/** In-memory backend: tests + graceful fallback when storage is missing. */
export class InMemoryMemoryBackend implements MemoryStorage {
  private data: unknown = null;
  /** Test hook: simulate a broken disk. */
  failOnSave = false;
  async load(): Promise<unknown> {
    return this.data;
  }
  async save(data: unknown): Promise<boolean> {
    if (this.failOnSave) return false;
    this.data = data;
    return true;
  }
  async clear(): Promise<void> {
    this.data = null;
  }
}

/**
 * chrome.storage.local backend (Chrome MV3 + Firefox `browser`
 * namespace — both promise-based). Missing API → load null / save
 * false; the store treats both as "no memory", never as fatal.
 */
export class ChromeStorageBackend implements MemoryStorage {
  private area(): { get: (k: string) => Promise<Record<string, unknown>>; set: (o: Record<string, unknown>) => Promise<void>; remove: (k: string) => Promise<void> } | null {
    try {
      const api = rawApi();
      const storage = api?.storage?.local;
      if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") return null;
      return storage;
    } catch {
      return null;
    }
  }
  async load(): Promise<unknown> {
    try {
      const area = this.area();
      if (!area) return null;
      const res = await area.get(MEMORY_LIMITS.STORAGE_KEY);
      return res?.[MEMORY_LIMITS.STORAGE_KEY] ?? null;
    } catch {
      return null;
    }
  }
  async save(data: unknown): Promise<boolean> {
    try {
      const area = this.area();
      if (!area) return false;
      await area.set({ [MEMORY_LIMITS.STORAGE_KEY]: data });
      return true;
    } catch {
      return false;
    }
  }
  async clear(): Promise<void> {
    try {
      await this.area()?.remove(MEMORY_LIMITS.STORAGE_KEY);
    } catch {
      /* discard-only */
    }
  }
}

interface StoredShape {
  version: number;
  records: VisualMemory[];
}

function isRecordShape(r: unknown): r is VisualMemory {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o["memoryId"] === "string" &&
    typeof o["domain"] === "string" &&
    typeof o["pageType"] === "string" &&
    Array.isArray(o["semanticFacts"]) &&
    (o["semanticFacts"] as unknown[]).every((f) => typeof f === "string" && isKnownFact(f)) &&
    Array.isArray(o["interactionPatterns"]) &&
    Array.isArray(o["taskPatterns"]) &&
    typeof o["confidence"] === "number" &&
    typeof o["fingerprint"] === "string" &&
    typeof o["version"] === "number"
  );
}

/** Load + validate + migrate (drop anything malformed or off-vocabulary). */
async function readRecords(backend: MemoryStorage): Promise<{ records: VisualMemory[]; dropped: number }> {
  let raw: unknown = null;
  try {
    raw = await backend.load();
  } catch {
    return { records: [], dropped: 0 };
  }
  if (!raw || typeof raw !== "object") return { records: [], dropped: 0 };
  const shape = raw as Partial<StoredShape>;
  if (shape.version !== MEMORY_LIMITS.SCHEMA_VERSION || !Array.isArray(shape.records)) {
    return { records: [], dropped: Array.isArray(shape.records) ? shape.records.length : 0 };
  }
  const records: VisualMemory[] = [];
  let dropped = 0;
  for (const r of shape.records) {
    if (isRecordShape(r)) records.push(r);
    else dropped++;
  }
  return { records, dropped };
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface TaskWriteInput {
  snapshots: ObservationSnapshot[];
  actions: AgentAction[];
  intent: TaskIntent;
  completed: boolean;
  now?: number;
}

export class VisualMemoryStore {
  constructor(private readonly backend: MemoryStorage = new InMemoryMemoryBackend()) {}

  /**
   * Full write pipeline: relevance → extract → sanitize (fail-closed) →
   * dedup → merge → confidence → retention → persist. Never throws;
   * returns stored=false with a reason when anything is off.
   */
  async writeFromTask(input: TaskWriteInput): Promise<{ stored: boolean; reason: string }> {
    try {
      return await this.writeInner(input);
    } catch {
      return { stored: false, reason: "write pipeline error (fail-closed)" };
    }
  }

  private async writeInner(input: TaskWriteInput): Promise<{ stored: boolean; reason: string }> {
    const now = input.now ?? Date.now();
    const usable = input.snapshots.filter((s) => s.pageType !== "unsupported" && hostOf(s.url));
    if (usable.length === 0) return { stored: false, reason: "no usable observation" };
    const latest = usable[usable.length - 1];
    const domain = hostOf(latest.url);
    const pageType = latest.pageType || "content";

    const factSet = new Set<SemanticFact>();
    for (const s of usable.slice(-3)) {
      for (const f of extractSemanticFacts(s)) factSet.add(f);
    }
    const facts = [...factSet].sort();
    const regionOrder = extractRegionOrder(latest);
    const patterns = extractInteractionPatterns(input.actions);
    const gate = shouldPersistCandidate(latest, facts, patterns);
    if (!gate.persist) return { stored: false, reason: gate.reason };

    const candidate = {
      domain,
      pageType,
      facts,
      regionOrder,
      patterns,
      operation: input.intent.operation,
      completed: input.completed,
    };
    // Independent privacy barrier: any PII/secret-shaped content in the
    // candidate (even from a Feature #1 miss) drops the whole write.
    if (!sanitizeCandidate(candidate)) return { stored: false, reason: "sensitive content in candidate" };

    const { records } = await readRecords(this.backend);
    const key = `${domain}::${pageType}`;
    const idx = records.findIndex((r) => `${r.domain}::${r.pageType}` === key);
    let next: VisualMemory[];
    if (idx >= 0) {
      const merged = mergeMemory(records[idx], facts, regionOrder, patterns, input.intent.operation, input.completed, now);
      if (!sanitizeCandidate(merged)) return { stored: false, reason: "sensitive content after merge" };
      next = [...records];
      next[idx] = merged;
    } else {
      const created = newMemory(domain, pageType, facts, regionOrder, patterns, input.intent.operation, input.completed, now);
      if (!sanitizeCandidate(created)) return { stored: false, reason: "sensitive content in record" };
      next = [...records, created];
    }
    const { kept } = enforceRetention(next, now);
    const payload: StoredShape = { version: MEMORY_LIMITS.SCHEMA_VERSION, records: kept };
    const bytes = JSON.stringify(payload).length;
    if (bytes > MEMORY_LIMITS.MAX_BYTES * 2) return { stored: false, reason: "payload over hard cap" };
    const ok = await this.backend.save(payload);
    return ok ? { stored: true, reason: idx >= 0 ? "merged" : "created" } : { stored: false, reason: "storage unavailable" };
  }

  /**
   * Full read pipeline: candidates → relevance → freshness/confidence
   * floors → current-state compatibility → bounded top-K. Usage
   * accounting persists best-effort; failures stay silent.
   */
  async recall(
    query: MemoryQuery,
    intentGoal: string,
    currentFacts: SemanticFact[],
    currentDomain: string,
    now: number = Date.now(),
  ): Promise<RetrievalResult[]> {
    try {
      return await this.recallInner(query, intentGoal, currentFacts, currentDomain, now);
    } catch {
      return [];
    }
  }

  private async recallInner(
    query: MemoryQuery,
    intentGoal: string,
    currentFacts: SemanticFact[],
    currentDomain: string,
    now: number,
  ): Promise<RetrievalResult[]> {
    const { records } = await readRecords(this.backend);
    if (records.length === 0) return [];
    const limit = Math.max(1, Math.min(query.limit || MEMORY_LIMITS.MAX_RETRIEVAL, 10));
    const scored = records
      .map((m) => {
        const rel = relevanceScore(m, query, intentGoal, now);
        const freshnessScore = freshnessOf(m.lastSeen, now);
        const confidenceScore = m.confidence;
        const compat = checkCompatibility(m, currentFacts, currentDomain);
        return { m, relevanceScore: rel, freshnessScore, confidenceScore, compatible: compat.compatible, reason: compat.reason };
      })
      .filter(
        (r) =>
          r.relevanceScore > 0 &&
          r.compatible &&
          effectiveConfidence(r.m, now) >= 0.3 &&
          freshnessOf(r.m.lastSeen, now) >= 0.4,
      )
      .sort((a, b) => b.relevanceScore - a.relevanceScore || b.confidenceScore - a.confidenceScore)
      .slice(0, limit);
    if (scored.length === 0) return [];
    // Usage accounting: mark validated + used, persist best-effort.
    try {
      const touched = new Set(scored.map((s) => s.m.memoryId));
      const next = records.map((r) =>
        touched.has(r.memoryId)
          ? { ...r, usageCount: r.usageCount + 1, lastValidated: now, provenance: { ...r.provenance, lastValidated: now } }
          : r,
      );
      await this.backend.save({ version: MEMORY_LIMITS.SCHEMA_VERSION, records: next });
    } catch {
      /* usage accounting must never break retrieval */
    }
    return scored.map(({ m, relevanceScore, freshnessScore, confidenceScore, compatible }) => ({
      memory: m,
      relevanceScore,
      freshnessScore,
      confidenceScore,
      compatible,
    }));
  }

  /** Compact planner context lines for compatible memories (never records). */
  contextLines(results: RetrievalResult[]): string[] {
    const out: string[] = [];
    for (const r of results.slice(0, 3)) {
      out.push(`known layout (${r.memory.domain}, observed ${r.memory.provenance.observationCount}x):`);
      out.push(...memoryContextLines(r.memory).map((l) => `  ${l}`));
    }
    return out;
  }
}
