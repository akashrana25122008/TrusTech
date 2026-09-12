/* ------------------------------------------------------------------ *
 * TaskInterpreter — parses the user's natural-language goal into a
 * structured TaskGoal with intent classification and simple entity
 * extraction. No LLM in the deterministic path; this is the local
 * heuristic fallback.
 * ------------------------------------------------------------------ */

import type { TaskGoal } from "./types";

const INTENT_HINTS: Array<{ pattern: RegExp; intent: TaskGoal["intent"] }> = [
  { pattern: /price|cost|₹|cheap|under \d|compare|deal|buy|shop|order|cart|amazon|flipkart/i, intent: "commerce" },
  { pattern: /search|find|look for|google|query/i, intent: "search" },
  { pattern: /navigate|go to|open|visit|load|page|site|url|website|\.com|\.in|\.org/i, intent: "navigation" },
  { pattern: /play|youtube|video|stream|watch/i, intent: "media" },
  { pattern: /fill|form|enter|input|submit|login|sign|register|account|email|password/i, intent: "form" },
  { pattern: /read|article|news|report|blog|post|story|medium|wikipedia/i, intent: "reading" },
  { pattern: /book|train|flight|ticket|seat|bus|travel|reserve|itinerary|route/i, intent: "booking" },
  { pattern: /download|save|export|pdf|file|screenshot|image|photo/i, intent: "download" },
];

const ENTITY_HINTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /₹\s?\d[\d,]*|rs\.?\s?\d[\d,]*|inr\s?\d[\d,]*|under\s?₹?\d[\d,]*/i, label: "price" },
  { pattern: /amazon|flipkart|myntra|meesho|nykaa|jio mart|bigbasket|swiggy|zomato|uber|rapido|irctc|makemytrip|redbus|abhibus/i, label: "site" },
  { pattern: /youtube|netflix|spotify|prime video|hotstar|jiocinema/i, label: "platform" },
  { pattern: /\b\d{4,6}\b/i, label: "code_or_pin" },
  { pattern: /laptop|phone|mobile|shoe|shirt|headphone|camera|watch|book|toy|kitchen|saree|dress|earphone/i, label: "category" },
  { pattern: /(?:choose|select|pick)\s+(?:the\s+)?(["'`]?[A-Za-z][A-Za-z .'-]{1,40}["'`]?)/i, label: "option" },
  { pattern: /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/i, label: "date" },
  // Search/media topic: "Search <topic> on YouTube…" / "find <topic>…" — the
  // words the agent should type into the destination's own search field, not
  // the platform name. Leading articles are stripped; trailing punctuation
  // and "and play/watch…" tails are not part of the query.
  { pattern: /(?:search|find|look\s+for|play|watch)\s+([A-Za-z][A-Za-z0-9 .+#-]{1,60}?)(?:\s+on\s+[A-Za-z][A-Za-z ]{1,20}|\s+and\s+(?:play|watch|open)|[?.!]*$)/i, label: "query" },
];

const LEADING_ARTICLES = /^(?:a|an|the)\s+/i;

function extractEntities(goal: string): TaskGoal["entities"] {
  const entities: TaskGoal["entities"] = [];
  for (const { pattern, label } of ENTITY_HINTS) {
    const m = goal.match(pattern);
    if (m) {
      // Prefer the capture group (extracted value) over the whole match.
      let value = (m[1] ?? m[0]).trim();
      if (label === "query") value = value.replace(LEADING_ARTICLES, "").trim();
      if (value) entities.push({ label, value, raw: m[0] });
    }
  }
  return entities;
}

function inferIntent(goal: string): TaskGoal["intent"] {
  const g = goal.toLowerCase();
  for (const { pattern, intent } of INTENT_HINTS) {
    if (pattern.test(g)) return intent;
  }
  return "general";
}

/** Goals that name a video platform as the place of action
 *  ("…on YouTube and play…", "Open YouTube and find…",
 *  "Find a tutorial on YouTube"). An explicit "on <platform>" constraint
 *  always selects the platform. Bare searches with no on-platform action
 *  ("search youtube tutorial") keep the search-engine start page,
 *  preserving existing search behavior. */
function targetsPlatform(goal: string, entities: TaskGoal["entities"]): boolean {
  const platform = entities.find((e) => e.label === "platform");
  if (!platform) return false;
  if (/play|watch|video|open|stream/i.test(goal)) return true;
  const name = platform.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bon\\s+(the\\s+)?${name}\\b`, "i").test(goal);
}

function inferSteps(goal: string, intent: TaskGoal["intent"], entities: TaskGoal["entities"]): string[] {
  const steps: string[] = [];
  if (targetsPlatform(goal, entities)) {
    // In-platform media flow: Groq/deterministic planners search, select and
    // open inside the platform itself — never a search-engine detour.
    steps.push("open the video platform");
    steps.push("enter the query");
    steps.push("submit the search");
    steps.push("select a relevant result");
    steps.push("open the selected video");
  } else if (intent === "search") {
    steps.push("navigate to the search engine");
    steps.push("enter the query");
    steps.push("submit the search");
    steps.push("read and return the top results");
  } else if (intent === "commerce") {
    steps.push("open the marketplace");
    steps.push("apply filters matching the request");
    steps.push("read prices and key specs");
    steps.push("present a comparison");
  } else if (intent === "navigation") {
    steps.push("navigate to the target");
  } else if (intent === "form") {
    steps.push("navigate to the form");
    steps.push("fill required fields");
    steps.push("submit");
  } else if (intent === "download") {
    steps.push("locate the file");
    steps.push("initiate download");
    steps.push("confirm completion");
  } else if (intent === "booking") {
    steps.push("navigate to the booking site");
    steps.push("enter travel details");
    steps.push("select available options");
    steps.push("present results");
  } else {
    steps.push("observe the page");
    steps.push("interact as needed");
    steps.push("read and return the answer");
  }
  steps.push("verify the result");
  return steps;
}

export function interpretTask(goal: string): TaskGoal {
  const intent = inferIntent(goal);
  const entities = extractEntities(goal);
  return {
    goal,
    intent,
    entities,
    steps: inferSteps(goal, intent, entities),
    startUrl: inferStartUrl(goal, intent, entities),
  };
}

/** Well-known video platforms resolve to their home page. */
function platformUrl(value: string): string {
  const v = value.toLowerCase().trim();
  if (v === "youtube") return "https://www.youtube.com";
  return `https://www.${v.replace(/\s+/g, "")}.com`;
}

function inferStartUrl(goal: string, intent: TaskGoal["intent"], entities: TaskGoal["entities"]): string | undefined {
  const site = entities.find((e) => e.label === "site");
  if (site) return `https://www.${site.value.toLowerCase().replace(/\s+/g, "")}.com`;
  // An explicitly named platform is the destination — the agent must drive
  // the real platform in the browser, not a search-engine detour.
  const platform = entities.find((e) => e.label === "platform");
  if (platform && targetsPlatform(goal, entities)) return platformUrl(platform.value);
  if (intent === "search") {
    return `https://www.google.com/search?q=${encodeURIComponent(goal)}`;
  }
  if (intent === "media" || /youtube|video|play/i.test(goal)) return "https://www.youtube.com";
  return undefined;
}