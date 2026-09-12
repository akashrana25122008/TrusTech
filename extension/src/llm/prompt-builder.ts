/* ------------------------------------------------------------------ *
 * PromptBuilder — assembles the structured conversation for the LLM.
 * Page content is always the firewall-sanitized snapshot, never raw
 * DOM or outbound-unsanitized text.
 * ------------------------------------------------------------------ */

import type { ObservationSnapshot } from "@/shared/messages";
import { LLM_GUARDRAILS } from "./llm-client";
import { PrivacyFirewall } from "@/privacy/firewall";

const SCHEMA = `Action kinds:
  navigate {"action":"navigate","url":"https://…"}
  new_tab / close_tab / switch_tab
  back / forward / reload
  click / double_click / type / clear / select / check / uncheck / radio /
  scroll / hover / focus / press_key
  wait {"action":"wait","ms":300}
  extract {"action":"extract","target":{"elementId":"el_001"}}
  submit / finish {"action":"finish","result":"answer text"}
Target: {"target":{"elementId":"el_001"}} OR {"target":{"role":"button","name":"Search"}}
Every value-bearing action may include {"expectedOutcome":{"type":"url_change"|"content_change"}}`;

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
}

const firewall = new PrivacyFirewall();

export function buildPrompt(
  goal: string,
  intent: string,
  snapshot: ObservationSnapshot,
  historyHint: string,
): BuiltPrompt {
  const scan = firewall.scan(snapshot.visibleText);
  const elements = snapshot.elements
    .filter((e) => e.visible)
    .map((e) => `${e.id} ${e.role} "${e.name.slice(0, 60)}"${e.tag ? ` <${e.tag}>` : ""}`)
    .slice(0, 40)
    .join("\n");

  const systemPrompt = `You control a browser through a strict action protocol.
${LLM_GUARDRAILS}

Action schema:
${SCHEMA}

Rules:
- Never output free text as an action payload.
- element ids are temporary — re-observe after any DOM change.
- If a target is unclear, prefer ask_user over guessing.
- High-risk actions (navigate away, close tab, pay) need explicit user confirmation via ask_user.`;

  const userPrompt = `Task: "${goal}"
Intent: ${intent}
History: ${historyHint || "none yet"}

Current page: ${snapshot.url}
Title: ${snapshot.title}
Viewport: ${snapshot.viewport.w}x${snapshot.viewport.h}

Visible text (sanitized by privacy firewall):
"""${scan.sanitized.slice(0, 1500)}"""

Indexed interactive elements:
${elements || "none"}`;

  return { systemPrompt, userPrompt };
}