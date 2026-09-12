import type { AgentStateKey, HighlightKind, Telemetry } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * Agent simulator — a deterministic stand-in for the future LLM/RL
 * runtime. Every event is expressed as a list that the UI reducer
 * applies on a timeline, so swapping in a real inference backend later
 * only requires replacing `planFor` with a streaming source.
 * ------------------------------------------------------------------ */

export interface HighlightEvent {
  kind: HighlightKind;
  label: string;
  selector?: string;
}

export interface SimEvent {
  /** milliseconds after task start */
  at: number;
  status: AgentStateKey;
  actionText: string;
  currentUrl?: string;
  currentTab?: string;
  step?: number;
  confidence?: number;
  privacy?: Telemetry["privacy"];
  browserControl?: boolean;
  highlight?: HighlightEvent;
  /** Number of PII fields redacted by the privacy firewall for outbound steps. */
  redacted?: number;
}

export interface AgentPlan {
  steps: string[];
  events: SimEvent[];
}

const STEPS = [
  "Opened target site",
  "Located interactive element",
  "Entered input",
  "Submitted action",
  "Analyzing results",
  "Verifying outcome",
];

/** Rough signal extraction from the free-form task, used only for labelling. */
export function inferTarget(task: string): { site: string; host: string; input: string; selector: string } {
  const t = task.toLowerCase();
  let site = "Target site";
  let host = "target-site.com";
  let input = "query";
  if (t.includes("youtube") || t.includes("tutorial")) {
    site = "YouTube";
    host = "youtube.com";
    input = "YouTube search";
  } else if (t.includes("gmail")) {
    site = "Gmail";
    host = "mail.google.com";
    input = "Gmail inbox";
  } else if (t.includes("amazon") || t.includes("product") || t.includes("compare")) {
    site = "Amazon";
    host = "amazon.com";
    input = "product search";
  } else if (t.includes("train")) {
    site = "Indian Railway";
    host = "erail.in";
    input = "journey search";
  }
  const selector =
    input === "YouTube search" ? 'input[name="search_query"], input[type="search"]' : 'input[type="search"], input[type="text"]';
  return { site, host, input, selector };
}

export function planFor(task: string): AgentPlan {
  const { site, host, input, selector } = inferTarget(task);

  const events: SimEvent[] = [
    {
      at: 0,
      status: "OBSERVING",
      actionText: `Scanning the current page and target — ${site}`,
      currentTab: site,
      currentUrl: host,
      step: 1,
      privacy: "SCANNING",
      browserControl: true,
      highlight: { kind: "navigate", label: `Opening ${site}`, selector: "body" },
    },
    {
      at: 900,
      status: "THINKING",
      actionText: `Locating the ${input} element`,
      step: 2,
      confidence: 96,
      highlight: { kind: "click", label: "Agent is locating the input", selector },
    },
    {
      at: 2100,
      status: "ACTING",
      actionText: `Typing into ${input}`,
      step: 3,
      confidence: 94,
      highlight: { kind: "type", label: "Agent is typing here", selector },
    },
    {
      at: 3400,
      status: "ACTING",
      actionText: "Submitting and waiting for results",
      step: 4,
      confidence: 91,
      highlight: { kind: "click", label: "Agent is submitting", selector: "button, form input[type=submit]" },
    },
    {
      at: 4800,
      status: "THINKING",
      actionText: "Analyzing results and ranking options",
      step: 5,
      confidence: 89,
      highlight: { kind: "scroll", label: "Agent is scanning results" },
    },
    {
      at: 6200,
      status: "ACTING",
      actionText: "Selecting the most relevant result",
      step: 6,
      confidence: 92,
      highlight: { kind: "click", label: "Agent is opening this result", selector: "a" },
    },
    {
      at: 7600,
      status: "SUCCESS",
      actionText: `Done. Verified outcome on ${site}`,
      confidence: 97,
      privacy: "SAFE",
      highlight: { kind: "clear", label: "Task completed" },
    },
    {
      at: 8200,
      status: "WAITING",
      actionText: "Waiting for confirmation — review what the agent did.",
      browserControl: true,
    },
  ];

  return { steps: [...STEPS], events };
}