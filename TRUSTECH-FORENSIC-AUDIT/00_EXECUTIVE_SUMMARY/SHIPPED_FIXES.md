# Recently Shipped Fixes

Messaging architecture: URL-guarded relays (http/https/localhost), page-type classifier, CTX_PING/PONG + CONTENT_READY handshake types, ContentChannel adapter injection, MessageRouter v3, controller handshake with timeout, panel THINKING-on-start. Tests green (69).
Bot integration: Interview-Mentor avatar replaces the procedural robot — agent-bot module (types, state adapter, glow textures, agentAvatarScene, AgentBot), RobotStage/Panel repointed, ~28 kB saved on the panel bundle; adapter tests added.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
