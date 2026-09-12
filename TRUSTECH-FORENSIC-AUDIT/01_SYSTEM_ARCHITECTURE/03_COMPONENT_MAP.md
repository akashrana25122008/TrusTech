# Component Map

extension/src groupings: background/{main, router, types, tab-manager, content-channel, navigation-manager, tab-state-repository, context-labeler, panel-advertiser, tabs, tabs-helpers, browser-tab-adapter, chrome, simulation-factory, mutation-router}, content/{main, channel, page-classifier, observer, indexer, grounder, executor, yt-companion}, agent/{controller, types, deterministic-planner, verifier, recovery-manager, task}, llm/{types, deterministic-provider, noop-provider, prompt-builder, response-parser, llm-provider-factory}, ui/{agent-bot, components, panels, cards, dock, stages}. Tests mirror in tests/extension.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
