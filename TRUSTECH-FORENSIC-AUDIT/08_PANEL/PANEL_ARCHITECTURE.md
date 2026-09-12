# Panel Architecture

React Root (panel.tsx) → useAgentState (state machine + bridge) → views: TelemetryScreen, RobotStage (AgentBot), BrowserControlDock, Panels (Selection/Input/Action), StatusCard, LogConsole.
Styling: globals.css + .agent-canvas.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
