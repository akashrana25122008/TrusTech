/* ------------------------------------------------------------------ *
 * VisualMemory — privacy-preserving semantic visual memory (Feature #5).
 *
 * Remembers HOW interfaces work (semantic regions, control patterns,
 * interaction shapes), never WHAT the user entered. Everything
 * persisted is drawn from CLOSED vocabularies — page text can never
 * become a fact, an instruction can never become a rule, and no
 * values, screenshots, DOM, PII or secrets are stored, period.
 *
 * Pure functions here (extract → sanitize → merge → score); persistence
 * lives in memory-store.ts. No network anywhere in this module.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { ObservationSnapshot } from "@/shared/messages";
import { scanText } from "@/privacy/fusion";
import { detectSecrets } from "@/privacy/secrets";

/** Closed vocabulary of storable semantic facts. Nothing else persists. */
export const SEMANTIC_FACTS = [
  "search_control",
  "filter_panel",
  "sort_control",
  "result_list",
  "product_cards",
  "price_labels",
  "pagination",
  "navigation_menu",
  "form_region",
  "auth_region",
  "sensitive_form_region",
  "content_region",
  "media_player",
] as const;

export type SemanticFact = (typeof SEMANTIC_FACTS)[number];

export type MemoryCategory =
  | "PAGE_STRUCTURE"
  | "UI_PATTERN"
  | "VISUAL_PATTERN"
  | "INTERACTION_PATTERN"
  | "TASK_PATTERN"
  | "NAVIGATION_PATTERN"
  | "SEMANTIC_FACT";

export type MemorySource = "LOCAL_OBSERVATION";

export interface InteractionPattern {
  trigger: string;
  outcome: string;
  count: number;
}

export interface TaskPattern {
  operation: string;
  steps: string[];
  completed: boolean;
}

export interface MemoryProvenance {
  sourceType: MemorySource;
  observationCount: number;
  lastValidated: number;
}

export interface VisualMemory {
  memoryId: string;
  domain: string;
  pageType: string;
  category: MemoryCategory;
  semanticFacts: SemanticFact[];
  /** Region order of first appearance (layout-robust, no coordinates). */
  regionOrder: SemanticFact[];
  interactionPatterns: InteractionPattern[];
  taskPatterns: TaskPattern[];
  confidence: number;
  observationCount: number;
  usageCount: number;
  createdAt: number;
  lastSeen: number;
  lastValidated: number;
  version: number;
  fingerprint: string;
  provenance: MemoryProvenance;
}

export interface MemoryQuery {
  domain?: string;
  pageType?: string;
  taskType?: string;
  semanticTags?: string[];
  limit: number;
}

export interface RetrievalResult {
  memory: VisualMemory;
  relevanceScore: number;
  freshnessScore: number;
  confidenceScore: number;
  compatible: boolean;
}

/** Centralized retention bounds — the ONLY size constants. */
export const MEMORY_LIMITS = {
  MAX_ENTRIES: 100,
  MAX_BYTES: 512 * 1024,
  MAX_FACTS_PER_RECORD: 40,
  MAX_PATTERNS_PER_RECORD: 20,
  MAX_RETRIEVAL: 5,
  SCHEMA_VERSION: 1,
  STORAGE_KEY: "trustech.visual-memory.v1",
} as const;

/* ---------------- semantic extraction ---------------- */

const PRICE_CUES = /₹|\$|€|£|price|cost|rs\.?\b|inr\b/i;
const PAGINATION_CUES = /\bpage \d+\b|\bnext\b.*\bprevious\b|\bprevious\b.*\bnext\b|\bload more\b|\bshow more\b/i;
const FILTER_CUES = /filter|sort by|sort:|refine|facets/i;

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function visibleEls(snapshot: ObservationSnapshot) {
  return snapshot.elements.filter((e) => e.visible);
}

/**
 * Extract closed-vocabulary facts from one observation. Reads roles,
 * tags and cue WORDS only — matched cue words are never stored, and
 * element names/values/titles/text are never read into facts.
 */
export function extractSemanticFacts(snapshot: ObservationSnapshot): SemanticFact[] {
  const els = visibleEls(snapshot);
  const facts = new Set<SemanticFact>();
  const hasRole = (...roles: string[]) => els.some((e) => roles.includes(e.role));
  const countRole = (...roles: string[]) => els.filter((e) => roles.includes(e.role)).length;
  const linkCount = els.filter((e) => e.role === "link" || e.tag === "a").length;

  if (els.some((e) => e.role === "searchbox")) facts.add("search_control");
  if (hasRole("combobox", "listbox") || countRole("checkbox", "radio") >= 2) facts.add("filter_panel");
  if (FILTER_CUES.test(snapshot.title)) facts.add("filter_panel");
  if (/sort/i.test(snapshot.title)) facts.add("sort_control");
  if (linkCount >= 3) facts.add(snapshot.pageType === "commerce" || PRICE_CUES.test(snapshot.title) ? "product_cards" : "result_list");
  if (PRICE_CUES.test(snapshot.title)) facts.add("price_labels");
  if (PAGINATION_CUES.test(snapshot.visibleText)) facts.add("pagination");
  if (linkCount >= 5 || hasRole("navigation")) facts.add("navigation_menu");
  const textboxes = els.filter((e) => e.role === "textbox" || e.tag === "input" || e.tag === "textarea");
  if (textboxes.length >= 2) facts.add("form_region");
  if (els.some((e) => e.tag === "input" && (e.type === "password" || /password|otp/i.test(e.name)))) {
    facts.add("auth_region");
    facts.add("sensitive_form_region");
  }
  if (els.some((e) => e.role === "video" || e.tag === "video")) facts.add("media_player");
  if (facts.size === 0 && els.length > 0) facts.add("content_region");
  return [...facts].sort();
}

/** Region order of first appearance (document order, coordinate-free). */
export function extractRegionOrder(snapshot: ObservationSnapshot): SemanticFact[] {
  const order: SemanticFact[] = [];
  const push = (f: SemanticFact) => {
    if (!order.includes(f)) order.push(f);
  };
  for (const e of visibleEls(snapshot)) {
    if (e.role === "searchbox") push("search_control");
    else if (e.role === "combobox" || e.role === "listbox" || e.role === "checkbox" || e.role === "radio") push("filter_panel");
    else if (e.role === "link" || e.tag === "a") push("result_list");
    else if (e.role === "textbox" || e.tag === "input" || e.tag === "textarea") {
      push(e.tag === "input" && (e.type === "password" || /password|otp/i.test(e.name)) ? "auth_region" : "form_region");
    } else if (e.role === "navigation") push("navigation_menu");
    else if (e.role === "video" || e.tag === "video") push("media_player");
  }
  return order.slice(0, 12);
}

/** Interaction op label — structural names only, never values. */
export function interactionOp(action: AgentAction): string {
  switch (action.action) {
    case "navigate":
    case "new_tab":
      return "navigate";
    case "type":
      return action.target?.role === "searchbox" ? "search_input" : "field_input";
    case "press_key":
      return "submit";
    case "click":
    case "double_click":
      return "activate";
    case "select":
    case "check":
    case "uncheck":
    case "radio":
      return "choose_option";
    case "submit":
      return "submit";
    case "back":
    case "forward":
    case "reload":
      return "retraverse";
    default:
      return "other";
  }
}

/**
 * Fold executed action pairs into counted op-pair patterns
 * (e.g. search_input → submit → navigate). Op names + counts only.
 */
export function extractInteractionPatterns(actions: AgentAction[]): InteractionPattern[] {
  const counts = new Map<string, number>();
  const ops = actions.map(interactionOp).filter((o) => o !== "other");
  for (let i = 0; i + 1 < ops.length; i++) {
    const key = `${ops[i]} → ${ops[i + 1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [trigger, outcome] = key.split(" → ");
      return { trigger, outcome, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, MEMORY_LIMITS.MAX_PATTERNS_PER_RECORD);
}

/* ---------------- fingerprint / identity ---------------- */

/**
 * Layout-tolerant semantic identity: normalized domain + page type +
 * sorted facts + region order. No coordinates, classes, ids, text.
 */
export function fingerprintMemory(domain: string, pageType: string, facts: SemanticFact[], regionOrder: SemanticFact[]): string {
  return [domain, pageType, [...facts].sort().join("+"), regionOrder.join(">")].join("|");
}

export function dedupKey(domain: string, pageType: string, fingerprint: string): string {
  return `${domain}::${pageType}::${fingerprint}`;
}

/* ---------------- relevance gate (write path) ---------------- */

/**
 * Only stable, reusable observations become memory. Rejects internal
 * pages, loading pages, fact-poor snapshots and transient states.
 */
export function shouldPersistCandidate(
  snapshot: ObservationSnapshot,
  facts: SemanticFact[],
  patterns: InteractionPattern[],
): { persist: boolean; reason: string } {
  if (snapshot.pageType === "unsupported" || !hostOf(snapshot.url)) {
    return { persist: false, reason: "no controllable page" };
  }
  if (snapshot.loading) return { persist: false, reason: "transient loading state" };
  if (facts.length < 2 && patterns.length === 0) return { persist: false, reason: "no reusable structure" };
  return { persist: true, reason: "stable reusable structure" };
}

/* ---------------- independent privacy barrier ---------------- */

/**
 * Fail-closed sanitizer: the serialized candidate must contain zero
 * PII/secret hits (Feature #1 + secrets, independent of the firewall)
 * AND every fact must belong to the closed vocabulary. Anything else
 * → DROP. Returns the clean candidate or null.
 */
export function sanitizeCandidate<T>(candidate: T): T | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(candidate) ?? "";
  } catch {
    return null;
  }
  if (scanText(serialized).length > 0) return null;
  if (detectSecrets(serialized).length > 0) return null;
  return candidate;
}

/** Validate a fact string against the closed vocabulary. */
export function isKnownFact(value: string): value is SemanticFact {
  return (SEMANTIC_FACTS as readonly string[]).includes(value);
}

/* ---------------- confidence ---------------- */

/** Explainable update: first sight LOW, +0.15 per consistent sight (cap 0.9). */
export function mergeConfidence(current: number, consistentSightings: number): number {
  return Math.min(0.9, Math.round((current + 0.15 * consistentSightings) * 100) / 100);
}

/** Freshness multiplier: <1d 1.0, <7d 0.8, <30d 0.6, else 0.4. */
export function freshnessOf(lastSeen: number, now: number = Date.now()): number {
  const age = now - lastSeen;
  if (age < 24 * 3600 * 1000) return 1.0;
  if (age < 7 * 24 * 3600 * 1000) return 0.8;
  if (age < 30 * 24 * 3600 * 1000) return 0.6;
  return 0.4;
}

/** Effective confidence = base × freshness (+validated bonus, cap 0.95). */
export function effectiveConfidence(m: VisualMemory, now: number = Date.now()): number {
  const validatedBonus = m.lastValidated >= m.lastSeen - 1000 && m.usageCount > 0 ? 0.05 : 0;
  return Math.min(0.95, Math.round(m.confidence * freshnessOf(m.lastSeen, now) * 100) / 100 + validatedBonus);
}

/* ---------------- merge ---------------- */

let memorySeq = 0;

/** Merge a fresh extraction into an existing record (dedup + union). */
export function mergeMemory(
  existing: VisualMemory,
  facts: SemanticFact[],
  regionOrder: SemanticFact[],
  patterns: InteractionPattern[],
  taskOperation: string,
  completed: boolean,
  now: number = Date.now(),
): VisualMemory {
  // Redesign detection: when most stored facts vanish from the new
  // observation, the page changed — drop the stale facts and penalize
  // confidence instead of accumulating contradictions forever.
  const retainedCount = existing.semanticFacts.filter((f) => facts.includes(f)).length;
  const retainedRatio = retainedCount / Math.max(1, existing.semanticFacts.length);
  const redesigned = retainedRatio < 0.5;
  const mergedFacts = (redesigned ? [...facts] : [...new Set([...existing.semanticFacts, ...facts])])
    .sort()
    .slice(0, MEMORY_LIMITS.MAX_FACTS_PER_RECORD);
  const patternMap = new Map(existing.interactionPatterns.map((p) => [`${p.trigger} → ${p.outcome}`, { ...p }]));
  for (const p of patterns) {
    const key = `${p.trigger} → ${p.outcome}`;
    const prev = patternMap.get(key);
    patternMap.set(key, prev ? { ...prev, count: prev.count + p.count } : { ...p });
  }
  const mergedPatterns = [...patternMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MEMORY_LIMITS.MAX_PATTERNS_PER_RECORD);
  const taskSteps = existing.taskPatterns.find((t) => t.operation === taskOperation);
  const taskPatterns = taskSteps
    ? existing.taskPatterns.map((t) =>
        t.operation === taskOperation ? { ...t, completed: t.completed || completed } : t,
      )
    : [...existing.taskPatterns, { operation: taskOperation, steps: [], completed }].slice(0, 8);
  const fingerprint = fingerprintMemory(existing.domain, existing.pageType, mergedFacts, regionOrder);
  const confidence = redesigned
    ? Math.max(0.25, Math.round((existing.confidence - 0.15) * 100) / 100)
    : mergeConfidence(existing.confidence, 1);
  return {
    ...existing,
    semanticFacts: mergedFacts,
    regionOrder: regionOrder.slice(0, 12),
    interactionPatterns: mergedPatterns,
    taskPatterns,
    confidence,
    observationCount: existing.observationCount + 1,
    lastSeen: now,
    version: existing.version + (existing.fingerprint === fingerprint ? 0 : 1),
    fingerprint,
    provenance: { ...existing.provenance, observationCount: existing.provenance.observationCount + 1 },
  };
}

/** Build a brand-new record (confidence starts LOW by design). */
export function newMemory(
  domain: string,
  pageType: string,
  facts: SemanticFact[],
  regionOrder: SemanticFact[],
  patterns: InteractionPattern[],
  taskOperation: string,
  completed: boolean,
  now: number = Date.now(),
): VisualMemory {
  const fingerprint = fingerprintMemory(domain, pageType, facts, regionOrder);
  return {
    memoryId: `mem_${now.toString(36)}_${(memorySeq++).toString(36)}`,
    domain,
    pageType,
    category: "PAGE_STRUCTURE",
    semanticFacts: [...facts].sort().slice(0, MEMORY_LIMITS.MAX_FACTS_PER_RECORD),
    regionOrder: regionOrder.slice(0, 12),
    interactionPatterns: patterns.slice(0, MEMORY_LIMITS.MAX_PATTERNS_PER_RECORD),
    taskPatterns: [{ operation: taskOperation, steps: [], completed }],
    confidence: 0.35,
    observationCount: 1,
    usageCount: 0,
    createdAt: now,
    lastSeen: now,
    lastValidated: 0,
    version: 1,
    fingerprint,
    provenance: { sourceType: "LOCAL_OBSERVATION", observationCount: 1, lastValidated: 0 },
  };
}

/* ---------------- retrieval ---------------- */

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
}

/**
 * Deterministic relevance: domain + pageType + task + semantic overlap +
 * freshness + confidence. No embeddings, no network.
 */
export function relevanceScore(
  m: VisualMemory,
  query: MemoryQuery,
  intentGoal: string,
  now: number = Date.now(),
): number {
  let score = 0;
  if (query.domain && m.domain === query.domain.replace(/^www\./, "")) score += 0.35;
  else if (query.domain) return 0; // wrong domain: never relevant
  if (query.pageType && m.pageType === query.pageType) score += 0.15;
  if (query.taskType && m.taskPatterns.some((t) => t.operation === query.taskType)) score += 0.15;
  const goalTokens = new Set(tokenize(intentGoal));
  const factTokens = new Set(m.semanticFacts.flatMap((f) => f.split("_")));
  let overlap = 0;
  for (const t of factTokens) if (goalTokens.has(t)) overlap++;
  score += 0.15 * Math.min(1, overlap / 3);
  if (query.semanticTags && query.semanticTags.length > 0) {
    const hits = query.semanticTags.filter((t) => m.semanticFacts.includes(t as SemanticFact)).length;
    score += 0.1 * (hits / query.semanticTags.length);
  }
  score += 0.05 * freshnessOf(m.lastSeen, now);
  score += 0.05 * m.confidence;
  return Math.round(Math.min(1, score) * 100) / 100;
}

/**
 * Current-state compatibility: same domain + pageType, and the stored
 * facts must largely still be present (current page wins ties).
 */
export function checkCompatibility(m: VisualMemory, currentFacts: SemanticFact[], currentDomain: string): { compatible: boolean; reason: string } {
  if (m.domain !== currentDomain) return { compatible: false, reason: `domain changed (${m.domain} → ${currentDomain || "none"})` };
  if (currentFacts.length === 0) return { compatible: false, reason: "no current structure to compare" };
  const retained = m.semanticFacts.filter((f) => currentFacts.includes(f)).length;
  const ratio = retained / Math.max(1, m.semanticFacts.length);
  if (ratio < 0.5) return { compatible: false, reason: `structure changed (${retained}/${m.semanticFacts.length} facts retained)` };
  return { compatible: true, reason: `${retained}/${m.semanticFacts.length} facts retained` };
}

/** Compact, explainable planner context (never whole records). */
export function memoryContextLines(m: VisualMemory): string[] {
  const level = m.confidence >= 0.7 ? "HIGH" : m.confidence >= 0.5 ? "MEDIUM" : "LOW";
  return [
    `known page type: ${m.pageType}`,
    `known semantic regions: ${m.semanticFacts.join(", ") || "none"}`,
    ...m.interactionPatterns
      .slice(0, 4)
      .map((p) => `known interaction: ${p.trigger} → ${p.outcome}`),
    `memory confidence: ${level} (observed ${m.provenance.observationCount} times)`,
  ];
}

/* ---------------- retention ---------------- */

/** Eviction rank: lowest effective-confidence × recency × use goes first. */
export function evictionRank(m: VisualMemory, now: number = Date.now()): number {
  const ageDays = Math.max(0, (now - m.lastSeen) / (24 * 3600 * 1000));
  return effectiveConfidence(m, now) * (1 + Math.log1p(m.usageCount)) / (1 + ageDays / 7);
}

/** Enforce bounds: evict worst-ranked first; drop oversized records. */
export function enforceRetention(records: VisualMemory[], now: number = Date.now()): { kept: VisualMemory[]; evicted: number } {
  const sized = records.filter((r) => {
    try {
      return (JSON.stringify(r) ?? "").length <= 8192;
    } catch {
      return false;
    }
  });
  if (sized.length <= MEMORY_LIMITS.MAX_ENTRIES) {
    const bytes = sized.reduce((n, r) => n + (JSON.stringify(r) ?? "").length, 0);
    if (bytes <= MEMORY_LIMITS.MAX_BYTES) return { kept: sized, evicted: records.length - sized.length };
  }
  const ranked = [...sized].sort((a, b) => evictionRank(a, now) - evictionRank(b, now));
  const over = ranked.length - MEMORY_LIMITS.MAX_ENTRIES;
  let kept = over > 0 ? ranked.slice(over) : ranked;
  let bytes = kept.reduce((n, r) => n + (JSON.stringify(r) ?? "").length, 0);
  while (bytes > MEMORY_LIMITS.MAX_BYTES && kept.length > 1) {
    kept = kept.slice(1);
    bytes = kept.reduce((n, r) => n + (JSON.stringify(r) ?? "").length, 0);
  }
  return { kept, evicted: records.length - kept.length };
}

/** Approximate serialized footprint (tests + diagnostics, no retention). */
export function serializedSize(records: VisualMemory[]): number {
  return records.reduce((n, r) => {
    try {
      return n + ((JSON.stringify(r) ?? "").length || 0);
    } catch {
      return n;
    }
  }, 0);
}
