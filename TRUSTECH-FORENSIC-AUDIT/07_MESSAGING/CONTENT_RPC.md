# Content RPC

Whitelisted relays (CTX_OBSERVE/CTX_GROUND/CTX_EXECUTE) do ensure(channel) → sendToTabAndRespond → relay the reply.
CTX_PING must be added so the controller handshake resolves to CTX_PONG.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
