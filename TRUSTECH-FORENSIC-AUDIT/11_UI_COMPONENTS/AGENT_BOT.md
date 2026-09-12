# Agent Bot

AgentBot.tsx hosts the canvas (agentAvatarScene). Procedural avatar: bust geometry, emissive materials, glow texture ramps, pointer/aim rig, DPR cap, visibility gate.
Motion machine maps BotState → motion; success halo + sheen on success; aura pulse; full dispose on unmount.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
