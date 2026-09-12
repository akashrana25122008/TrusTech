// Generates the TRUSTECH-FORENSIC-AUDIT/ documentation deliverable.
// Content is drawn from the forensic audit (audit-only; no source modified).
// Format: a single template literal; each file introduced by ==>  path  then
// markdown body lines until the next ==> marker. The block must contain NO
// backticks and NO ASCII double quotes (curly quotes used where needed).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = new URL("../TRUSTECH-FORENSIC-AUDIT/", import.meta.url).pathname;

const SCOPE = `*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.`;

const BLOCK = `

==> 00_EXECUTIVE_SUMMARY/00_ROOT_CAUSE_SUMMARY.md
# Root Cause Summary

Chain of causation (one sentence each):
1. ERROR 1 — content script cannot load. Vite multi-entry build split a shared runtime chunk; dist/js/content.js line 1 is import{r as m}from"./runtime-D5Is3KbA.js"; MV3 content_scripts are classic scripts, so the browser throws Uncaught SyntaxError: Cannot use import statement outside a module on every page.
2. ERROR 2 — Could not establish connection. Receiving end does not exist. The content script is dead, so chrome.tabs.sendMessage to it has no receiver.
3. UI stuck on Connecting to the browser… . The router never relays CTX_PING (the CONTENT_RPC_TYPES whitelist omits it) and chrome.ts onMessage always returns true, so the panel handshake promise never resolves.
4. Latent gaps: dock page commands (unknown_command), back/forward silent false success, GET_TAB/LIST_TABS unrouted, SW-restart tab loss, no-op panel events, rubber-stamp verification.

==> 00_EXECUTIVE_SUMMARY/OVERVIEW.md
# Overview

TrusTech is an MV3 Chrome side-panel AI browser-agent. The full architecture is present in source (~85–90%), but the shipped bundle is broken end-to-end (~15–18% functional control).
What works at build level: panel and background (module) bundle fine; 69 unit tests pass; typecheck clean.
What is broken at runtime: content script (SyntaxError), panel–content handshake (hang), dock page actions (unknown_command), back/forward (silent false success), SW-restart tab loss, no-op panel events, rubber-stamp verification.
Companion bot avatar: the Interview-Mentor visual was integrated and verified (budget OK, 69 tests green).

==> 00_EXECUTIVE_SUMMARY/KEY_FINDINGS.md
# Key Findings

1. Critical — content.js is ESM inside a classic script; browser parse failure on every page (ERROR 1).
2. Critical — CTX_PING not relayed by the router whitelist and onMessage always returns true; handshake hangs (ERROR 3, ERROR 2).
3. High — dock page commands routed to BROWSER_COMMAND, which has no click/type/scroll/select cases → unknown_command.
4. High — back/forward go through dead content; the adapter swallows delivery failure → false success.
5. Medium — tabMgr.active() is an in-memory cache; MV3 SW restart wipes it → no_active_tab.
6. Medium — GET_TAB / LIST_TABS have callers in the panel but no router cases.
7. Medium — sendPanelEvent is a no-op in background/main.ts.
8. High — deterministic planner never sets expectedOutcome, so the verifier always reports ok.
9. Medium — NoopLlmProvider active; prompt-builder / response-parser are unreachable.
10. Medium — planner gaps: choose-result, multi-field form, select-option, date; no multi-tab state.
Composite functional control score ≈ 11/61 ≈ 18%.

==> 00_EXECUTIVE_SUMMARY/SCORECARD.md
# Scorecard

Composite functional control score: 11/61 ≈ 18%.
Breakdown: browser control 4/19; webpage action handling 4/11; task completion 0/11; content script 2/6; system integrity 1/8; integration 0/6.
Architecture/design completeness is substantially higher (~85–90%): the gap is runtime wiring, not roadmap.

==> 00_EXECUTIVE_SUMMARY/SHIPPED_FIXES.md
# Recently Shipped Fixes

Messaging architecture: URL-guarded relays (http/https/localhost), page-type classifier, CTX_PING/PONG + CONTENT_READY handshake types, ContentChannel adapter injection, MessageRouter v3, controller handshake with timeout, panel THINKING-on-start. Tests green (69).
Bot integration: Interview-Mentor avatar replaces the procedural robot — agent-bot module (types, state adapter, glow textures, agentAvatarScene, AgentBot), RobotStage/Panel repointed, ~28 kB saved on the panel bundle; adapter tests added.

==> 01_SYSTEM_ARCHITECTURE/01_COMMAND_FLOW.md
# Command Flow

Panel layer: useAgentState → bridge.command() → tab → MessageRouter → targeted service → chrome.* API → web page (content script or tabs API).
Agent layer: controller.start(request) → planner → action → executor (CTX_EXECUTE or browser action) → observation → verifier/recovery loop.
Panel events: background → panel via sendPanelEvent (currently a no-op).

==> 01_SYSTEM_ARCHITECTURE/02_RUNTIME_MODELS.md
# Runtime Models

Three MV3 contexts:
1. Service worker (module): router, TabManager, tabStateRepository, ContentChannel, adapter. Controller is instantiable only in the panel.
2. Side panel: React app + PanelTransportAdapter + agent/controller + dock.
3. Content script: ContentChannel + observer/indexer/grounder/executor (currently blocked by the build bug).
Shared runtime.ts provides sendRaw and message wrappers.

==> 01_SYSTEM_ARCHITECTURE/03_COMPONENT_MAP.md
# Component Map

extension/src groupings: background/{main, router, types, tab-manager, content-channel, navigation-manager, tab-state-repository, context-labeler, panel-advertiser, tabs, tabs-helpers, browser-tab-adapter, chrome, simulation-factory, mutation-router}, content/{main, channel, page-classifier, observer, indexer, grounder, executor, yt-companion}, agent/{controller, types, deterministic-planner, verifier, recovery-manager, task}, llm/{types, deterministic-provider, noop-provider, prompt-builder, response-parser, llm-provider-factory}, ui/{agent-bot, components, panels, cards, dock, stages}. Tests mirror in tests/extension.

==> 01_SYSTEM_ARCHITECTURE/ARCHITECTURE_SCORE.md
# Architecture Score

Design presence is high (~85–90%): complete message protocol, RPC whitelists, URL guards, adapter injection for testability, executor safety allowlist, MV3-correct background, jsdom test suite.
Runtime wiring is where the gaps live — a finishing problem, not a redesign problem.

==> 01_SYSTEM_ARCHITECTURE/DATA_FLOW.md
# Data Flow

Page → observer events → ContentChannel relay (CTX_PAGE_CHANGED) → router → tabStateRepository + panel (events, currently disabled) → panel AgentState → UI.
Grounding: indexer → grounder → CTX_GROUND payloads.
Agent commands: PanelTransportAdapter → CTX_* → router → executor.
Dock: BROWSER_COMMAND → router → TabService (limited to tab-level commands).

==> 02_PACKAGE_BUILD/BUILD_CONFIGURATION.md
# Build Configuration

Vite 5 single config (vite.config.ts): inputs panel (html), content (ts), background (ts); entries under js/{name}.js; chunks js/{name}-[hash].js; es2020 target; react plugin; @ alias → extension/src.
Build script: icons && tsc --noEmit && vite build. Vitest jsdom, includes tests/**/*.test.ts.

==> 02_PACKAGE_BUILD/BUILD_ARTIFACTS.md
# Build Artifacts

dist/: index.html (tooling stub), panel.html, extension.html, assets/panel-*.css, js/{background,content,panel,runtime-*}.js, icons/*, manifest.json + firefox copy.
Background and panel are modules (valid); content is declared classic but references a shared chunk (invalid).

==> 02_PACKAGE_BUILD/CONTENT_BUILD_BUG.md
# Content Build Bug (ERROR 1)

dist/js/content.js line 1: import{r as m}from'./runtime-D5Is3KbA.js';
Cause: Rollup hoists the shared runtime module into a chunk when multiple inputs share code; MV3 has no type:module for content_scripts, so the browser refuses the file.
Fix: build the content entry standalone as a classic IIFE with inlineDynamicImports (see 23_FIX_PLAN/FIX_PLAN_1).

==> 02_PACKAGE_BUILD/DIST_ANATOMY.md
# Dist Anatomy

runtime-D5Is3KbA.js exports {o as i, r} (rawApi): the code-split runtime pulled out of content.js.
panel.js is large (699.91 kB — three.js) and loads via a script type=module tag in panel.html — valid.
background.js imports the runtime chunk — valid (SW is type module).
content.js alone is the broken artifact.

==> 02_PACKAGE_BUILD/SOURCEMAP_SUMMARY.md
# Sourcemap Summary

sourcemap: false in the build config; no sourcemaps in dist. Error traces point at minified bundle lines, which complicated the audit; root cause was confirmed by artifact inspection, not stack traces.

==> 03_PUBLIC_MANIFEST/MANIFEST_ANALYSIS.md
# Manifest Analysis

manifest.json: MV3; permissions {tabs, activeTab, tabGroups, scripting, sidePanel, storage, alarms}; host_permissions http/https/localhost; side_panel path panel.html; background service_worker background.js type module; content_scripts matches http/https/localhost, css inject.css, js js/content.js, no type → classic. Icons 16/48/128.

==> 03_PUBLIC_MANIFEST/PERMISSIONS_POLICY.md
# Permissions Policy

Permissions are scoped to the declared capability set. tabs for metadata reads; activeTab grants temporary scripting on user gesture; scripting supports fallback injection; tabGroups for grouping; storage for state; alarms for watchdogs.
No all_urls — good store posture.

==> 03_PUBLIC_MANIFEST/CONTENT_SCRIPTS.md
# Content Scripts

Declared: matches http/https/localhost, js/content.js, css inject.css, run_at document_idle, no type field (classic).
The current content.js breaks its own contract (ESM import). After FIX_PLAN_1 the artifact must contain zero top-level imports/exports.

==> 03_PUBLIC_MANIFEST/BACKGROUND.md
# Background

service_worker js/background.js, type module (valid; may import chunks).
Path must stay js/background.js after the FIX_PLAN_1 build split.

==> 03_PUBLIC_MANIFEST/SIDE_PANEL.md
# Side Panel

side_panel section with default_path panel.html; opened via chrome.sidePanel.setPanelBehavior (openPanelOnActionClick) in background main; panel.html loads module scripts (panel.js).

==> 03_PUBLIC_MANIFEST/FIREFOX_VARIANT.md
# Firefox Variant

manifest.firefox.json present. Firefox has no sidePanel API; the variant inherits the panel architecture decisions.
Left unverified in this audit; part of the FIX_PLAN_14 real-world matrix.

==> 04_EXTENSION_SOURCE/SOURCE_TREE.md
# Source Tree

extension/src: background (9 modules), content (9 modules incl. yt-companion), agent (6), llm (7), ui (agent-bot, components, panels, cards, dock, stages; legacy three modules removed in the bot integration).
tsconfig strict; tests/ mirrors suites per area.

==> 04_EXTENSION_SOURCE/ENTRY_POINTS.md
# Entry Points

background/main.ts (SW boot + listeners); content/main.ts (boot classifier, channel, listeners); panel.html → panel.tsx (React root).
Each entry strictly follows MV3 context separation.

==> 04_EXTENSION_SOURCE/SYSTEM_ACCESS.md
# System Access

Chrome APIs touched: tabs.query/get/update/remove/captureVisibleTab/sendMessage/create, sidePanel, scripting (fallback), groups, alarms, runtime.onMessage.
All exercised through BrowserTabAdapter so tests inject fakes.

==> 04_EXTENSION_SOURCE/INDEXER.md
# Indexer

Builds a DOM index (roles, buttons, inputs, links, form fields, landmarks, iframes).
Guards: visible-only via offsetParent, capture-phase collection, debounce, subtree persistence, resilience to DOM mutation during snapshot. Feeds the grounder.

==> 04_EXTENSION_SOURCE/OBSERVER.md
# Observer

MutationObserver + debounce → CONTENT_READY / PAGE_CHANGED events; tracks state (ACTIVE/BUSY/SUPPRESSED); URL-guarded relaying; routes mutations internally.

==> 04_EXTENSION_SOURCE/GROUNDER.md
# Grounder

Semantic/structural linking: closest labeled control selection, data-gk grounding keys, form-field clustering (label/aria/placeholder), fieldMap building.
Caveats documented for shadow-DOM and iframes.

==> 05_BROWSER/CHROME_ADAPTER.md
# Chrome Adapter

BrowserTabAdapter: queryActiveTab, getTab, listTabs, captureVisibleTab, navigateTab, createTab, switchTab, closeTab, reloadTab, injectFallback, sendToTab, sendToTabAndRespond, sendAndRespond, deliver, sendRaw via runtime.ts.
Injectable fakes are used in every test.

==> 05_BROWSER/CONNECTIVITY.md
# Connectivity

sendToTab wraps chrome.tabs.sendMessage in a promise; sendAndRespond resolves on lastError; deliver maps payloads.
The onMessage wrapper always returns true — the unconditional keepalive is a handshake hazard (see 13_KNOWN_BUGS_AND_ISSUES).

==> 05_BROWSER/TABS.md
# Tabs

TabManager: registerActiveTab/refresh/purpose tagging (internal/target/active/closed/gap); active() is an in-memory cache, lost on SW restart.
tabs-helpers provide family helpers; TabStateRepository stores per-tab context snapshots.

==> 05_BROWSER/NAVIGATION_MANAGER.md
# Navigation Manager

run() navigates to an id/url category via adapter calls; validates scheme; back/forward execute history through content injection; supports new-tab, close-tab (tabGroups cleanup), switch-tab, reload.
Zone: NavigationContext holds tabId/pages/position.

==> 05_BROWSER/QUERY_ENGINE.md
# Query Engine

tabs.query with window sorting for active lookup; captureVisibleTab feeds grounding; pageTitleSnapshot as fallback.

==> 05_BROWSER/SIMULATION.md
# Simulation

SimulationFactory provides deterministic simulated tabs/controller contexts for tests/scratchpad when no live browser of the expected shape exists — used in controller/adapter seams.

==> 05_BROWSER/SW_RESILIENCE.md
# SW Resilience

Gap: on SW restart the in-memory tabMgr and tabStateRepo are empty; the router answers QUERY_ACTIVE_TAB from tabMgr.active() → no_active_tab.
Fix: resolve active tab via adapter.queryActiveTab() (always fresh); keep tabMgr for bookkeeping only (FIX_PLAN_9).

==> 06_CONTENT_SCRIPT/CONTENT_CHANNEL.md
# Content Channel

ContentChannel (classic-script compatible): ports to the observer, client subscriptions (ensure/forget), publishes CONTENT_READY/PAGE_CHANGED; ensure() is used by the router before RPC; attachments are guarded by the URL whitelist.

==> 06_CONTENT_SCRIPT/BOOTSTRAP.md
# Bootstrap

content/main.ts: classifier → channel.attachListeners + handleMessage → observer.attach (with unsupported-page fallback and guarded bot overlays) → handshake (CTX_PING / CONTENT_READY broadcast).
All future behavior (RPC, PAGE_CHANGED, execute) hangs off this boot — which currently crashes at parse time.

==> 06_CONTENT_SCRIPT/PAGE_RELAY.md
# Page Relay

Relays page DOM/post-message events to the background; maps to CTX_PAGE_CHANGED / CTX_TITLE_UPDATED / CTX_TARGET_SPOTTED; guarded by the page classifier and protocol checks.

==> 06_CONTENT_SCRIPT/COMMAND_EXECUTOR.md
# Command Executor

performAction allowlist: click, type, select, scroll (plus back/forward). Fallback element picking when no selector is given; waits for injection; returns no result feedback to background.
AGENT_INJECT_ACTION allowed set: click, type, scroll, select, back, forward.

==> 06_CONTENT_SCRIPT/EVENT_GENERATION.md
# Event Generation

Mutation events → debounced summaries (targetCounts/mutationTypes/textSnippet); instrumentation routes.
Bot overlays and the YouTube companion attach only on whitelisted pages.

==> 06_CONTENT_SCRIPT/CONTENT_BUILD_BUG.md
# Content Build Bug (runtime impact)

Because the classic script fails at parse time, none of the above executes: no CONTENT_READY, no CTX_PONG, no PAGE_CHANGED, no observe/ground/execute.
This single artifact cascades into ERROR 2 and the panel hang.

==> 07_MESSAGING/MESSAGE_PROTOCOL.md
# Message Protocol

RPC envelope {type, payload}; type groups: browser RPC (inbound to background/panel), CONTENT_RPC (relayed to content), AGENT_* (injected actions/broadcasts), CTX_* (content → background), EVENT_* (background → panel), BROWSER_COMMAND* (dock → router), QUERY_* (panel → background).
Responses via the chrome sendResponse promise.

==> 07_MESSAGING/ROUTER_ANALYSIS.md
# Router Analysis

MessageRouter v3: guards (URL scheme via page-type classification, capability policy), CONTENT_RPC whitelist = {CTX_OBSERVE, CTX_GROUND, CTX_EXECUTE} — CTX_PING is missing → the panel handshake never completes.
BROWSER_COMMAND switch = {newTab, closeTab, switchTab, reload, back, forward, navigate} — no click/type/scroll/select → dock page actions get unknown_command.
No GET_TAB / LIST_TABS cases; QUERY_ACTIVE_TAB uses the stale-cache path.

==> 07_MESSAGING/CONTENT_RPC.md
# Content RPC

Whitelisted relays (CTX_OBSERVE/CTX_GROUND/CTX_EXECUTE) do ensure(channel) → sendToTabAndRespond → relay the reply.
CTX_PING must be added so the controller handshake resolves to CTX_PONG.

==> 07_MESSAGING/BROWSER_COMMAND_MAP.md
# Browser Command Map

The dock sends BROWSER_COMMAND {command, selector?, value?} for tab commands AND page actions.
Router handles only the 7 tab commands. Missing: click/type/scroll/select → AGENT_INJECT_ACTION to content; clear/check/uncheck/radio/hover/focus/press_key/submit/extract → CTX_EXECUTE path.

==> 07_MESSAGING/PANEL_EVENT_CHANNEL.md
# Panel Event Channel (disconnected)

Background sends EVENT_CONTENT_READY / EVENT_PAGE_CHANGED via sendPanelEvent → no-op (background/main.ts). PanelTransportAdapter.onMessage is a no-op.
The panel never learns pages changed or content readiness except through its own queries.

==> 07_MESSAGING/HANDSHAKE.md
# Handshake (ERROR 2 / ERROR 3)

Controller: sendRpc(CTX_PING) → router → should relay to content → CTX_PONG back.
Failure chain: content dead (ERROR 1) OR CTX_PING unrouted; chrome.ts onMessage returns true unconditionally, so the response promise is left unresolved even when no meaningful response exists → UI stuck on Connecting to the browser….

==> 08_PANEL/PANEL_ARCHITECTURE.md
# Panel Architecture

React Root (panel.tsx) → useAgentState (state machine + bridge) → views: TelemetryScreen, RobotStage (AgentBot), BrowserControlDock, Panels (Selection/Input/Action), StatusCard, LogConsole.
Styling: globals.css + .agent-canvas.

==> 08_PANEL/PANEL_TRANSPORT.md
# Panel Transport

PanelTransportAdapter: sendRpc (browser/agent/scan/invoke), sendTabCommand, sendToBackground, onMessage, batchEmitter, and _rpc variants.
Uses GET_TAB / LIST_TABS which have no router cases (see 13).

==> 08_PANEL/STATE_MACHINE.md
# State Machine

AgentStatus: THINKING → (READY|GATHERING) → OBSERVING → ACTIVE → … → DONE/ERROR/CANCELLED.
Panel renders status + error; the bot avatar maps via bot-state-adapter (idle/working/thinking/success/error/unavailable).

==> 08_PANEL/TELEMETRY_SCREEN.md
# Telemetry Screen

Displays queue/dock wiring: current tab URL, status chip, telemetry toggles; updated via useAgentState (background query → state).
True push updates (page-change events) are missing until FIX_PLAN_10.

==> 08_PANEL/USE_AGENT_STATE.md
# useAgentState

Manages the browserControl boot flag, mini/agent state machine, error strings, telemetry, navigation, dock/scratchpad, and the agent bot mode.
On handshake timeout it renders an explicit ERROR state rather than the old silent stuck banner.

==> 09_AGENT/CONTROLLER.md
# Controller

Handles start/stop/cancel/execute/navigate; runs the planner→action pipeline; handshake via CTX_PING with timeout; BROWSER_LEVEL_ACTIONS {navigate, new-tab, close-tab, switch-tab, reload, back, forward, tab-list} run locally, everything else via CTX_EXECUTE.
On handshake failure → ERROR + Connecting to the browser… message.

==> 09_AGENT/END_TASK.md
# End Task

endTask builds a concise summary, keeps the request visible until dismissed, sets an error state on failure, toasts; cancels pending polls; respects user-cancel semantics.

==> 09_AGENT/BOT_STATE_ADAPTER.md
# Bot State Adapter

mapAgentToBot: AgentStatus → BotState (idle, working, thinking, success, error, unavailable) with 1:1 exhaustive coverage + a default of idle; unit-tested.
AgentBot consumes the state → motion machine (damped), aura, success halo, particles.

==> 10_LLM/LLM_ARCHITECTURE.md
# LLM Architecture

LLM seam: provider interface, factory (NoopProvider default, DeterministicProvider for tests), prompt-builder + response-parser for instruction contracting; backend/ FastAPI gateway exists as a separate process but is unconnected.

==> 10_LLM/PROMPT_BUILDER.md
# Prompt Builder

Builds constrained action instructions from task + observed DOM snapshot (structured).
Developed but unreachable: NoopLlmProvider never invokes it and the router has no pathway from task execution to an LLM round-trip.

==> 10_LLM/RESPONSE_PARSER.md
# Response Parser

Parses provider responses into agent-level actions/types; validates against the broker switch.
Unused in the active path.

==> 10_LLM/LLM_PROVIDERS.md
# LLM Providers

NoopLlmProvider (active; always returns the fallback), DeterministicLlmProvider (used in tests for reproducible turns).
No network provider wired; the models/ runtime workstreams were reviewed under models/ for a later phase.

==> 10_LLM/BACKEND_GATEWAY.md
# Backend Gateway

backend/ FastAPI multi-model gateway exists but is neither invoked by the extension nor required for the foundation fixes (Parts 1–11).
LLM-first behavior is deferred to FIX_PLAN_12.

==> 11_UI_COMPONENTS/UI_TREE.md
# UI Tree

panel.tsx → AppShell → {TelemetryScreen, RobotStage, BrowserControlDock, Panels, StatusCard/StatusStrip, LogConsole}; components/panels/cards host screen scaffolds; globals.css design tokens; agent-bot module for the living avatar.

==> 11_UI_COMPONENTS/AGENT_BOT.md
# Agent Bot

AgentBot.tsx hosts the canvas (agentAvatarScene). Procedural avatar: bust geometry, emissive materials, glow texture ramps, pointer/aim rig, DPR cap, visibility gate.
Motion machine maps BotState → motion; success halo + sheen on success; aura pulse; full dispose on unmount.

==> 11_UI_COMPONENTS/DOCK.md
# Dock

BrowserControlDock: New Tab, Close Tab, Switch Tab, Reload, Back, Forward, Navigate (tab commands) + Click, Type, Scroll, Select (page actions).
Page actions send BROWSER_COMMAND → currently unknown_command (see 13).

==> 11_UI_COMPONENTS/STAGE.md
# Stage

RobotStage wraps the canvases; onChamberReady mounts the avatar; the legacy procedural robot was removed in the bot integration (saved ~28 kB; panel.js 699.91 kB ≤ original 726.5 kB).

==> 11_UI_COMPONENTS/PANEL_LAYOUT.md
# Panel Layout

Fixed left rail (actions), center telemetry/log, avatar stage; theme tokens in globals.css with .agent-canvas styling; responsive to the side-panel width.

==> 11_UI_COMPONENTS/STYLING.md
# Styling

CSS variables (glass, neon accents, status colors), canvas reset, glow utilities; no external UI framework — hand-rolled components consistent with design tokens.

==> 12_TESTS_SUITES/TEST_MATRIX.md
# Test Matrix

69 tests, vitest + jsdom: controller/adapter/fakeWeb (handshake, CTX_* flows), router (projection/permission/relay/BROWSER_COMMAND), content envoy paths, bot-state-adapter (2), executor/indexer/grounder/observer, navigation, tab-state repo, messaging. All pass.

==> 12_TESTS_SUITES/MESSAGING_TESTS.md
# Messaging Tests

Cover URL guards, content whitelist relaying, BROWSER_COMMAND subset, channel ensure/forget, controller handshake (fakeWeb answers CTX_PING → CTX_PONG).
Missing: CTX_PING relay assertion, GET_TAB/LIST_TABS, panel event path, SW-restart active-tab — added by the respective repair parts.

==> 12_TESTS_SUITES/AGENT_TESTS.md
# Agent Tests

Planner produces action-turns; verifier default-heuristic always ok (no expectedOutcome coverage); recovery-manager unit flows; endTask summary; noop/deterministic provider pairs.

==> 12_TESTS_SUITES/UI_TESTS.md
# UI Tests

bot-state-adapter mapping is exhaustive (6 statuses → BotState + default). Canvas/three scenes are browser-only (not unit-tested).

==> 12_TESTS_SUITES/TEST_ENVIRONMENT.md
# Test Environment

vitest 2.1.9 + jsdom 30; jsdom is required for DOM modules; the adapter/fakeWeb pattern keeps chrome.* out of unit tests; tsc --noEmit is the typecheck gate; build gate is icons + typecheck + vite build.

==> 13_KNOWN_BUGS_AND_ISSUES/BUGS_INDEX.md
# Bugs Index

B1 content.js ESM-in-classic (ERROR 1) — critical, verified in dist.
B2 receiving-end-does-not-exist (ERROR 2) — consequence of B1.
B3 UI stuck connecting (ERROR 3) — CTX_PING unrouted + always-true onMessage.
B4 dock page commands unknown_command; B5 back/forward false success; B6 SW-restart no_active_tab; B7 GET_TAB/LIST_TABS unrouted; B8 sendPanelEvent no-op; B9 verifier rubber-stamp; B10 planner action gaps; B11 noop LLM.

==> 13_KNOWN_BUGS_AND_ISSUES/ERROR_1_IMPORT.md
# ERROR 1 — SyntaxError in content.js

Evidence: dist/js/content.js line 1: import{r as m}from'./runtime-D5Is3KbA.js';
Chrome: Uncaught SyntaxError: Cannot use import statement outside a module (every page).
Root cause: Vite hoisted the shared runtime chunk. Fix: FIX_PLAN_1 (standalone IIFE entry).

==> 13_KNOWN_BUGS_AND_ISSUES/ERROR_2_RECEIVING_END.md
# ERROR 2 — Could not establish connection

Evidence: panel/adapter sendRpc to content → Could not establish connection. Receiving end does not exist. because the content script never registered a receiver (ERROR 1).
Secondary: a sendAndRespond to a missing port raises the same error.

==> 13_KNOWN_BUGS_AND_ISSUES/ERROR_3_UI_STUCK.md
# ERROR 3 — UI stuck on Connecting to the browser…

Evidence: controller.handshake awaits sendRpc(CTX_PING); the router whitelist lacks CTX_PING so the RPC dies in the background; chrome.ts onMessage returns true → the sender response promise is never resolved → UI stays connecting (now with an explicit ERROR state after timeout).

==> 13_KNOWN_BUGS_AND_ISSUES/CONNECTION_PHASES.md
# Connection Phases

1) page loaded → content boot (parse) 2) content → CONTENT_READY 3) panel → CTX_PING → CTX_PONG 4) paint/gesture → browser control ready.
Phase 1 is dead; phase 3 is blocked by the router whitelist.

==> 14_RUNTIME_BEHAVIOR/CONTENT_BOOT.md
# Content Boot Flow

match → content.js parse (FAILS) → no channel → no ready signal → no RPC → no observe/ground/execute. All downstream runtime features are off.

==> 14_RUNTIME_BEHAVIOR/BACKGROUND_BOOT.md
# Background Boot Flow

SW main: sidePanel open-on-action, alarms, listeners, MessageRouter(adapter).
Booting the panel does not create chrome-side channels; the router relays on demand.

==> 14_RUNTIME_BEHAVIOR/PANEL_BOOT.md
# Panel Boot Flow

panel.html loads panel.js (module) → React → TelemetryScreen measures the active tab via GET_TAB (unrouted → undefined) → controller start → handshake (fails/hangs per above) → ERROR state rendered with the bot unavailable.

==> 14_RUNTIME_BEHAVIOR/EXTENSION_RELOAD.md
# Extension Reload

Reloading re-injects content scripts on navigation; the SW context resets (tabMgr + tabState wipe).
If the bundle were correct, content would re-boot on page load; today reload keeps failing at parse.

==> 14_RUNTIME_BEHAVIOR/SW_RESTART.md
# SW Restart

MV3 SW can restart after ~30s idle: in-memory TabManager active-tab cache + tabStateRepository become empty → QUERY_ACTIVE_TAB returns no_active_tab, GET_TAB undefined, RELOAD/BACK etc. no-op → misreported.

==> 14_RUNTIME_BEHAVIOR/CRASH_SCENARIOS.md
# Crash Scenarios

content parse crash (B1); chrome://, about:, edge://, file: pages → ensure() refusal → graceful unsupported-page state (desired, mostly present); captive/net-error pages handled by the classifier; extensions pages blocked by the URL allowlist.

==> 15_SECURITY_SAFETY_CATEGORY/PERMISSIONS_REVIEW.md
# Permissions Review

Scoped host_permissions http/https/localhost; tabs for metadata; activeTab temporary; scripting fallback; no all_urls; no background fetch to third parties by default. Low attack surface.

==> 15_SECURITY_SAFETY_CATEGORY/URL_SCHEMES.md
# URL Schemes

The classifier and URL-guarded relays restrict content paths to http/https/localhost. chrome://, about:, edge:, view-source, devtools, file:, extension: are blocked → unsupported-page flow (FIX_PLAN_3).

==> 15_SECURITY_SAFETY_CATEGORY/VALIDATION.md
# Validation

RPC envelope type whitelist; executor action allowlist (performAction + AGENT_INJECT_ACTION sets); capability policy gates; no arbitrary JavaScript from LLM input (the agent emits structured actions only) — this invariant must survive LLM integration.

==> 15_SECURITY_SAFETY_CATEGORY/CAPABILITY_LIMITS.md
# Capability Limits

No file downloads, no exposed code in web_accessible_resources, no cross-origin fetch policies beyond user grant; all user-data access is offline. Unsafe schemes never auto-run.

==> 15_SECURITY_SAFETY_CATEGORY/STORE_POLICY.md
# Store Policy

MV3, single-purpose browser agent with a side-panel visual companion; host permissions match the stated function; content_scripts scoped; no eval; no remote JS. Visual companion performance budget honored.

==> 16_CONTROL_GRID/CONTROL_CATEGORIES.md
# Control Categories

A) Browser control (navigation/tabs/windows). B) Webpage action handling (click/type/select/scroll/observe). C) Task completion (multi-step goals). D) Content script health (boot/relay/readiness). E) System integrity (state/events/resilience). F) Integration/UX (panel telemetry, LLM wiring, feedback loops).

==> 16_CONTROL_GRID/LETTER_BRACKET_SCORES.md
# Letter Bracket Scores

A 4/19 — switch/back/forward/close partial; no reload share; tab-list gap.
B 4/11 — observe/ground/execute reachable only in tests; dock page actions unrouted; no live executor.
C 0/11 — no end-to-end task runs.
D 2/6 — syntax health 0, boot 0, observe-relay assist 1, event feed 0, readiness 1, expandability 0.
E 1/8 — state model good; events 0; resilience 0; active-tab 1-of-2; refresh 0.
F 0/6 — telemetry partial; LLM 0; nav 0-live; forced advance 0; feedback 0; logging 0-live.

==> 16_CONTROL_GRID/SCORE_ACCOUNT.md
# Score Accounting

Sum = 4 + 4 + 0 + 2 + 1 + 0 = 11 of max (19 + 11 + 11 + 6 + 8 + 6 = 61). Composite ≈ 18%.
Scores update AFTER each verified fix, never during (see 23_FIX_PLAN payloads).

==> 16_CONTROL_GRID/CAPABILITY_MATRIX.md
# Capability Matrix

| Capability | In source | Works live |
|---|---|---|
| content boot | content/main | NO (B1) |
| handshake | controller + router | NO (B2/B3) |
| observe/ground | content + router | tests only |
| execute | content executor | tests only |
| dock page actions | router | NO (B4) |
| back/forward | navigation-manager | NO (B5) |
| active tab | tabMgr | intermittent (B6) |
| tab list/get | router | NO (B7) |
| panel events | background | NO (B8) |
| verify/recover | agent | rubber (B9) |
| LLM | seam | NO (B11) |

==> 16_CONTROL_GRID/BARRIER_NOTES.md
# Barrier Notes

P0: dist artifact ESM-in-classic. P0: router whitelist + keepalive. P1: honest action plumbing (dock, back/forward, tab list). P1: verification semantics. P2: LLM + multi-tab + vision/privacy.

==> 17_CAPABILITY_OVERVIEW_BARRIERS_C_API/CAPABILITY_OVERVIEW.md
# Capability Overview

Premium futuristic AI browser agent: side panel, living avatar companion, telemetry, browser control dock, agentic task loops (planner/verifier/recovery), observation/grounding pipeline, isolated LLM seam + backend gateway blueprint.

==> 17_CAPABILITY_OVERVIEW_BARRIERS_C_API/BARRIER_MATRIX.md
# Barrier Matrix

P0-Critical: content bundle; handshake. P1-Essential: dock actions; back/forward honesty; tab list/get; panel events; SW active-tab; real verification. P2-Advanced: LLM providers + backend; multi-tab orchestration; vision; privacy-tier; Firefox parity.

==> 17_CAPABILITY_OVERVIEW_BARRIERS_C_API/CATEGORY_INDEXES.md
# Category Indexes

Map categories → sections: A → 05_BROWSER + 07_MESSAGING; B → 06_CONTENT_SCRIPT + 07; C → 09_AGENT + 23 PLANS 7/8/11; D → 06; E → 05 + 08 + SW/events; F → 08 + 10 + 23 PLANS 10/12.

==> 17_CAPABILITY_OVERVIEW_BARRIERS_C_API/PRODUCT_OVERVIEW.md
# Product Overview

Webstore pitch: one-click conversational browser agent in the side panel with an expressive avatar; goal-driven navigation, form/result interaction, telemetry; safety-first scoping. The repair milestone is the trusted execution core (Parts 1–14).

==> 18_FAILURE_MODES_CATALOG/FAILURE_MODES.md
# Failure Modes

parse-crash; no-receiver; unmatched-command; silent-success; SW-cache-miss; no-op-broadcast; rubber-stamp verification; LLM timeouts; unsupported-scheme prompts; DOM churn during capture; iframe/shadow-DOM grounding gaps; multi-tab context loss.

==> 18_FAILURE_MODES_CATALOG/EXAMPLE_SCENARIOS.md
# Example Scenarios

open yt memes → YouTube held: NEW_TAB resolves the SITE_SET report, but no content → category C fails.
Type a comment → nothing reaches the page (B4). chrome://wiki → nothing. Switch tab → restore-data chat wipes. Back from a result → false success while the page is static.

==> 18_FAILURE_MODES_CATALOG/DEGRADATION.md
# Degradation Policy

On failure: explicit ERROR state in the panel (never silent); recovery retries are bounded; unsupported pages report a clear message with content suppressed.
Current code has the intent; wiring gaps make some paths silent (B5).

==> 18_FAILURE_MODES_CATALOG/OBSERVABILITY.md
# Observability

The logConsole surfaces agent/log lines in the panel; sendPanelEvent was intended to push content/background → panel, but is a no-op today → operators cannot see the page-change feed, content readiness, or silent failures. FIX_PLAN_10 fixes the channel.

==> 19_OBSERVABILITY_TRACING_MONITORING/OBSERVABILITY.md
# Observability

The telemetry screen shows the active tab + status; footer has single key logs; no event stream.
After FIX_PLAN_10 the panel receives EVENT_CONTENT_READY + EVENT_PAGE_CHANGED and the logConsole appends lines.

==> 19_OBSERVABILITY_TRACING_MONITORING/DASHBOARD_SPEC.md
# Dashboard Spec

Planned view: connection status (5 phases), content readiness, active tab info, page-change feed, agent turn timeline, verifier outcomes, recovery events, error codes with timestamps.

==> 19_OBSERVABILITY_TRACING_MONITORING/TELEMETRY.md
# Telemetry

Current: boot flag, browserControl flag, status chip, tabs. Desired: event counters (PAGE_CHANGED/sec), handshake latency, turn counts, per-action outcomes. Metrics computed from the event channel once wired.

==> 19_OBSERVABILITY_TRACING_MONITORING/AUDITING.md
# Auditing

Audit trail of actions (ts, tabId, action, target, outcome) in LogConsole/state; privacy-safe (no page content by default). Backend audit export is post-LLM (FIX_PLAN_12/16).

==> 20_STANDARD_ERROR_CODES_AND_KINDS/ERROR_CODES.md
# Error Codes

Defined kinds: runtime lastError; CONNECTION — Could not establish connection; syntax-parse errors; unknown_command; no_active_tab; unsupported_url.
Proposed taxonomy: E1xx content, E2xx routing, E3xx agent, E4xx LLM, E5xx system.

==> 20_STANDARD_ERROR_CODES_AND_KINDS/ERROR_AND_LOGS.md
# Error & Logs

LogConsole: {level, timestamp, source, message}; sendPanelEvent is a no-op today → logs remain local to the panel. Log next to the repaired panel channel (FIX_PLAN_10).

==> 20_STANDARD_ERROR_CODES_AND_KINDS/MESSAGE_LOGS.md
# Message Logs

Router/debug metadata preserved; bridge dispatch-level logging exists in tests; end-to-end message logs require the event channel.

==> 20_STANDARD_ERROR_CODES_AND_KINDS/ERROR_TREE.md
# Error Tree

root: dist artifact → content-dead → handshake-hang; switch-missing → unknown_command; cache-cache → no_active_tab; broadcast-noop → stateless UI; heuristic-verify → blind pass. Each maps 1:1 to a FIX_PLAN part.

==> 21_GRADING_CONCEPT/GRADING.md
# Grading

Grading is capability-based: for each control cell we require (a) code path present, (b) live path verified in a real browser, (c) honest outcome reporting, (d) recovery handling. A cell only counts when (b)+(c) hold.

==> 21_GRADING_CONCEPT/SCORE_SCALES.md
# Score Scales

0 = absent/paraplegic; 1 = code present but not live-verifiable; 2 = live-verified but no outcome honesty/recovery; 3 = fully graded cell (live + honest + recovery + test). Letter scores = sum of cell grades.

==> 21_GRADING_CONCEPT/GRADING_MATRIX.md
# Grading Matrix

A (browser control): new-tab, close-tab, switch-tab, reload, back, forward, navigate, tab-list, group-tabs, active.
B (action handling): observe, ground, execute, dock-click, dock-type, dock-scroll, dock-select, result-pick, form-fill, option.
C (task): 3 end-to-end scenarios. D health: parse, boot, readiness, events, relay, expandability.
E system: state, events, resilience, active-tab-cache, refresh/resync, security. F integration: telemetry, feedback loop, LLM, forced-advance, navigation-ux, logging.

==> 21_GRADING_CONCEPT/OVERALL_SCORE.md
# Overall Score

11/61 ≈ 18%. Nothing counts as functional until repair parts are applied AND browser-verified. Target after Parts 1–14: ≥ 37/61. Recompute in FIX_PLAN_15 (re-audit).

==> 21_GRADING_CONCEPT/ACHIEVEMENT_BANDS.md
# Achievement Bands

0–19% = broken artifact. 20–40% = trusted core live (Parts 1–11). 41–65% = agentic and observant (verification, recovery, events, behaviors, real-world). 66–100% = advanced (LLM, multi-tab, vision/privacy, Firefox).

==> 22_PRIORITY_TREE/PRIORITY_P0.md
# Priority P0 (blockers)

P0.1 dist/js/content.js must be classic-valid (FIX_PLAN_1).
P0.2 the router must relay CTX_PING so the panel handshake resolves (FIX_PLAN_2).
P0.3 never resolve a response promise without an answer (chrome.ts regression guard).

==> 22_PRIORITY_TREE/PRIORITY_P1.md
# Priority P1 (core control)

P1.1 dock page actions honest (FIX_PLAN_5). P1.2 back/forward honest + GET_TAB/LIST_TABS (FIX_PLAN_4). P1.3 panel event channel + telemetry (FIX_PLAN_10). P1.4 SW-restart active tab (FIX_PLAN_9). P1.5 real verification + recovery (FIX_PLAN_7/8). P1.6 task behaviors (FIX_PLAN_11).

==> 22_PRIORITY_TREE/PRIORITY_P2.md
# Priority P2 (advanced)

P2.1 LLM step-up (FIX_PLAN_12). P2.2 multi-tab state (FIX_PLAN_13). P2.3 real-world suite incl. Firefox (FIX_PLAN_14). P2.4 vision/privacy tiers (FIX_PLAN_16).

==> 22_PRIORITY_TREE/PRIORITY_MATRIX.md
# Priority Matrix

| ID | Part | Why | Severity |
|---|---|---|---|
| P0.1 | 1 | ERROR 1 | critical |
| P0.2 | 2 | ERROR 3 | critical |
| P0.3 | 4 | silent success | high |
| P1.1 | 5 | dock UX dead | high |
| P1.2 | 4 | tab UX dead | high |
| P1.3 | 10 | observability | medium |
| P1.4 | 9 | SW correctness | medium |
| P1.5 | 7,8 | agent correctness | high |
| P1.6 | 11 | task completion | medium |
| P2.1 | 12 | product value | medium |
| P2.2 | 13 | multi-tab | medium |
| P2.3 | 14 | ship-safe | medium |
| P2.4 | 16 | premium | low |

==> 22_PRIORITY_TREE/CRITICAL_BLOCKERS.md
# Critical Blockers

Blocker 1: content.js parse failure (verified in dist).
Blocker 2: CTX_PING unrouted + always-true onMessage (verified in source).
Blocker 3: dock page commands unrouted.
Resolve these before any live end-to-end test can pass.

==> 23_FIX_PLAN/FIX_PLAN.md
# Fix Plan (Master)

Ordered parts 0–16, one at a time, each verified (unit + build; real browser by the operator) before the next: 0 baseline → 1 content build → 2 handshake/routing → 3 unsupported pages → 4 browser control routing → 5 webpage-action routing → 6 observation+grounding live → 7 verification engine → 8 recovery engine → 9 SW resilience → 10 panel event channel → 11 task behaviors → 12 LLM integration → 13 multi-tab state → 14 real-world suite → 15 re-audit → 16 advanced.
Never advance past an unverified part.

==> 23_FIX_PLAN/FIX_PLAN_0_BASELINE.md
# Part 0 — Baseline Snapshot

Capture pre-repair state: builds, artifact errors, git (no commits), 69 tests pass, dist content.js ESM bug, unrouted CTX_PING, disconnected panel events.
Record in docs/repair/baseline.md. Do NOT change functional code. Verify by running build + tests and writing the baseline document.

==> 23_FIX_PLAN/FIX_PLAN_1_CONTENT_BUILD.md
# Part 1 — Content Script Build Fix

Goal: dist/js/content.js is a classic script with zero top-level import/export and no runtime-chunk dependency.
Approach: split the build — main config builds panel+background (module); a second config builds the content entry alone with output.format iife + inlineDynamicImports, entryFileNames js/content.js, emptyOutDir false, copyPublicDir false. Build script: main then content.
Verify: no top-level imports/exports in dist/js/content.js; load on google.com + youtube.com with no SyntaxError.

==> 23_FIX_PLAN/FIX_PLAN_2_HANDSHAKE.md
# Part 2 — Handshake / Message Routing

Add CTX_PING to the router CONTENT_RPC_TYPES so the panel handshake pings the content channel and answers CTX_PONG; keep onMessage returning true ONLY when a real async responder is pending; add a regression test for the ping relay.
Verify: the panel transitions past Connecting to the browser….

==> 23_FIX_PLAN/FIX_PLAN_3_UNSUPPORTED_PAGES.md
# Part 3 — Unsupported Page Handling

chrome://, about:, edge:// etc. must produce a graceful not-supported-on-this-page state — never false OBSERVING/ACTIVE or a silent no-op. Content suppresses; the UI shows unsupported + bot unavailable; the controller clears agent state on scheme change.

==> 23_FIX_PLAN/FIX_PLAN_4_BROWSER_CONTROL.md
# Part 4 — Browser Control Routing

Route BROWSER_COMMAND switchTab/back/forward/reload/close fully; back/forward must surface real delivery failures (stop swallowing); add GET_TAB and LIST_TABS router cases; remove the bogus navigate-to-empty-tabId.
Verify with a real tab: switch, reload, back/forward outcomes match the page.

==> 23_FIX_PLAN/FIX_PLAN_5_WEBPAGE_ACTIONS.md
# Part 5 — Webpage Action Routing

Dock click/type/scroll/select → router relays AGENT_INJECT_ACTION to the active tab after ensure() (content must be alive); respond honestly when ensure fails.
Extend the executor allowed-set to the full documented set via CTX_EXECUTE for advanced actions.

==> 23_FIX_PLAN/FIX_PLAN_6_OBSERVATION_GROUNDING.md
# Part 6 — Observation + Grounding Live

Once content boots (Part 1), verify observe/ground live: CONTENT_READY + page summary + grounding keys reach the panel; regression tests for indexer/grounder against fixtures.

==> 23_FIX_PLAN/FIX_PLAN_7_VERIFICATION_ENGINE.md
# Part 7 — Verification Engine

The deterministic planner must emit expectedOutcome per step; the verifier compares observed state (url/title/content/dialogs) to the expectation and returns a real ok/bad/unsure — no blind pass. Unit tests target each template.

==> 23_FIX_PLAN/FIX_PLAN_8_RECOVERY.md
# Part 8 — Recovery Engine

Bounded retry + fallback when the verifier says bad/unsure; recover navigation/action errors; cap attempts; surface recovery log lines to the panel.

==> 23_FIX_PLAN/FIX_PLAN_9_SW_RESILIENCE.md
# Part 9 — Active Tab / SW Resilience

Resolve the active tab via adapter.queryActiveTab() (fresh from the browser) instead of the in-memory cache in router active-tab paths; keep tabMgr for bookkeeping/events; after a SW restart the next message follows the current tab.

==> 23_FIX_PLAN/FIX_PLAN_10_PANEL_EVENTS.md
# Part 10 — Panel Event Channel

Wire sendPanelEvent to broadcast EVENT_CONTENT_READY / EVENT_PAGE_CHANGED over runtime.sendMessage; the panel listens via runtime.onMessage and updates telemetry (url) + logConsole; the background never swallows delivery errors.

==> 23_FIX_PLAN/FIX_PLAN_11_TASK_BEHAVIORS.md
# Part 11 — Task Behaviors

Planner behaviors: choose-result (pick among results), fill-form-fields (multi-field), select-option (dropdown), date-selection (input type=date); verify with form/search widget tests and a real youtube/wiki scenario.

==> 23_FIX_PLAN/FIX_PLAN_12_LLM.md
# Part 12 — LLM Integration

Only after 1–11 verified: swap the provider seam to a typed action contract (keep the validator); prompt-builder + response-parser become reachable; the backend gateway is an optional step-up; explicit user permission before any network call.

==> 23_FIX_PLAN/FIX_PLAN_13_MULTITAB.md
# Part 13 — Multi-Tab State

Implement multi-tab navigation context: per-tab purpose tags, context switch, window group headers; COTE-NTEXT model keyed by tab; tests for cross-tab planning.

==> 23_FIX_PLAN/FIX_PLAN_14_REAL_WORLD.md
# Part 14 — Real-World Suite

Scripted scenarios: YouTube (search → watch), Wikipedia (search → read), Google (query → result click), checkout-form fill, date/select widgets; record PASS/FAIL with artifacts; Chrome + Firefox smoke.

==> 23_FIX_PLAN/FIX_PLAN_15_REAUDIT.md
# Part 15 — Re-Audit

Full re-run of the forensic audit against the repaired tree: dist artifacts valid, router whitelist complete, event channel live, verification honest, score recomputed; update every document in this tree to reflect the repaired state.

==> 23_FIX_PLAN/FIX_PLAN_16_ADVANCED.md
# Part 16 — Advanced Features

After 1–14 verified: vision (screenshot → grounding), privacy-tier (no-DOM mode), Firefox parity, LLM provider expansion, automated observability dashboard.

==> FINAL_REPORT/00_FINAL_REPORT.md
# Final Report

Deliverable covering the full forensic audit of TrusTech. Ship-blocking errors (ERROR 1/2/3), category grading (16/21), the prioritized fix plan (23), and the repair execution log. Verdict: architecture complete, runtime wiring broken (bundle + routing + events + verification); resolution staged Parts 0–16.

==> FINAL_REPORT/01_EXECUTIVE_SUMMARY.md
# Executive Summary

TrusTech UI, avatar, messaging design, and test scaffolding are strong (~85–90% of the roadmap in source). The shipped artifact cannot run: the content script is invalid ESM, the handshake whitelist is incomplete, and several control paths are unrouted or dishonest. Composite functional control ≈ 18%. A bounded 17-part repair restores a trusted, observable, verifiable browser agent.

==> FINAL_REPORT/02_DESIGN_ANALYSIS.md
# Design Analysis

The message protocol + whitelist + URL guards are a strong foundation; executor allowlists and the verifier intent are confirmed. Single negative: the control graph (router switch) drifted from call-site expectations (dock pages, tab list, panel events) — the source of most B-tier failures.

==> FINAL_REPORT/03_RUNTIME_ANALYSIS.md
# Runtime Analysis

Runtime phases: content parse (fail) → handshake (hang) → dock (unknown) → back/forward (silent) → SW-restart (stale) → events (void) → verification (rubber). Each maps to a repair part; all are code changes, not design changes.

==> FINAL_REPORT/04_SECURITY_REVIEW.md
# Security Review

No critical security findings. Permissions scoped, schemes guarded, executor allowlisted, no remote code, no eval.
Recommendations: central error-code taxonomy; action audit log; an LLM contract validator before network providers; explicit user intent for high-impact actions.

==> FINAL_REPORT/05_CODE_QUALITY.md
# Code Quality

Strict TypeScript, adapter/fakeWeb testability, small focused modules, accurate sparse comments. Technical debt concentrated in runtime wiring (single-source switch vs call-sites) and the handshake keepalive antipattern.

==> FINAL_REPORT/06_GRADING.md
# Grading

Composite 11/61 ≈ 18%. Letters: A 4/19, B 4/11, C 0/11, D 2/6, E 1/8, F 0/6. Recompute after each verified part; target ≥ 37/61 post-Parts 1–14.

==> FINAL_REPORT/07_LOGS_TRACES_AUDIT.md
# Logs Traces Audit

Two verified runtime errors (SyntaxError / receiving-end) reproduced in dist artifacts; message traces confirm the handshake stall; the panel logConsole exists but the event stream is unplugged. Post-FIX_PLAN_10 the panel receives the real event feed.

==> FINAL_REPORT/08_OPERATIONS.md
# Operations

Build = icons + typecheck + build (two-phase after FIX_PLAN_1). Test = vitest jsdom (69). Dev loop: tsc --noEmit → vitest → build → load unpacked → manual browser script. No CI yet; recommend adding the build-artifact grep checks as a CI step.

==> FINAL_REPORT/SCORE_MATRIX.md
# Score Matrix

Full 61-cell matrix with per-cell notes (0/1/2/3 scale), grouped A–F, plus the live-vs-code caveat. See 16_CONTROL_GRID for the same data by category.

==> FINAL_REPORT/CONCLUSION.md
# Conclusion

TrusTech is a strong design one wiring pass away from being a credible browser agent. The three P0 blockers are small, well-understood fixes (build split, whitelist add, honest keepalive). Execute Parts 0–16 in order; Part 15 re-grades.

==> FINAL_REPORT/NEXT_STEPS.md
# Next Steps

1) Execute FIX_PLAN_0 baseline snapshot. 2) FIX_PLAN_1 content build split. 3) FIX_PLAN_2 handshake routing. 4) FIX_PLAN_4/5 control routing. 5) FIX_PLAN_7/8 verification + recovery. 6) FIX_PLAN_9/10 resilience + events. 7) FIX_PLAN_11 behaviors. 8) Re-run the 61-cell grading (FIX_PLAN_15). 9) LLM + advanced (12/13/14/16).
`;

// Parse: lines; each "==> path" starts a file; body continues until next marker.
const lines = BLOCK.split("\n");
let current = null;
let body = [];
const files = {};
for (const line of lines) {
  if (line.startsWith("==> ")) {
    if (current) files[current] = body.join("\n").replace(/^\n+|\s+$/g, "");
    current = line.slice(4).trim();
    body = [];
  } else if (current) {
    body.push(line);
  }
}
if (current) files[current] = body.join("\n").replace(/^\n+|\s+$/g, "");

for (const [rel, content] of Object.entries(files)) {
  const abs = join(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content + "\n\n---\n" + SCOPE + "\n");
}
console.log(`Wrote ${Object.keys(files).length} files under ${ROOT}`);