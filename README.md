# TrusTech — AI Browser Agent

A premium, cinematic AI browser **agent**. Runs as a persistent **vertical side
panel** (Chrome MV3 Side Panel + Firefox Sidebar) with a real-time **3D robot
companion** (Three.js) that observes, thinks, acts, waits and verifies on your
behalf — backed by a local-first privacy/risk layer and a FastAPI gateway.

```
BROWSER   = the world        EXTENSION  = the AI control room
3D ROBOT  = the AI agent     HUD        = the agent's state
IN-PAGE   = what the AI is doing right now
PRIVACY   = the firewall between the page and any remote
```

---

## Monorepo layout

```
TrusTech/
├── extension/                React + TS + Chrome/Firefox Extension API
│   ├── public/               manifest.json + generated icons (copied into dist/)
│   ├── panel.html            side panel entry
│   └── src/
│       ├── ui/               components, hooks, three (robot), styles
│       ├── agent/            planner (sim) + controller (observe→plan→risk→execute→verify)
│       ├── browser/          BrowserAdapter + chrome.ts + firefox.ts
│       ├── content/          in-page overlay + trusted action executor
│       ├── background/       worker: tabs / panels / message router
│       ├── vision/           provider interfaces + capability detection (Transformers.js / WebGPU / WASM / PaddleOCR)
│       ├── privacy/          PII detection + dynamic redaction + privacy firewall
│       ├── security/         Action Risk Engine (confirmation-gated execution)
│       └── shared/           domain types, runtime seams, message protocol
├── backend/                  Python + FastAPI gateway (schemas/agents/vision/privacy/security/services/middleware)
├── models/                   local-first model registry (ONNX / Transformers.js / PaddleOCR)
├── infrastructure/aws/       Fargate + ECS + S3 deploy sketch (terraform)
├── docker/                   backend + development + production images, Caddyfile
├── tests/                    vitest suites for privacy, risk, planner/controller, router
└── build/                    icon generator
```

## Official stack targets (MASTER ENGINEERING DIRECTIVE)

| Layer       | Choice |
|-------------|--------|
| Frontend    | React 18 · TS · Vite 5 · Chrome/Firefox Extension APIs |
| Brain       | FastAPI (Python) backend gateway · LLM provider interface |
| Vision      | Transformers.js (WebGPU/WASM) · ONNX Runtime Web · PaddleOCR-compatible OCR |
| Privacy     | PII detection · dynamic redaction · privacy firewall · Action Risk Engine |
| Deployment  | Docker (backend/dev/prod) · AWS Fargate · S3/CloudFront |
| Local AI    | model registry in `models/`; never bundled with the MV3 worker |

The extension ships a **working simulation** of the plan loop (`agent/planner.ts`)
so the panel, robot and overlay are fully functional now. Swapping it for the
FastAPI gateway only changes where `SimEvent`s come from.

---

## Getting started

```bash
npm install
npm run dev        # develop the panel at http://localhost:5173/extension/panel.html
npm test           # vitest: privacy, risk, planner/controller, router (18 cases)
npm run build      # typecheck + icons + bundle into dist/
```

### Install as an extension

**Chrome** (MV3 Side Panel ≥ 114):
1. `npm run build`
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → `dist/`
3. Click the TrusTech toolbar icon — the side panel opens.

**Firefox** (≥ 115):
1. `npm run build`
2. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/manifest.json`
3. Open the **TrusTech Agent** sidebar from the toolbar.

### Backend

```bash
python3 -m venv backend/.venv && source backend/.venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload
```
Run from the repo root (`uvicorn` and `pytest` both need the root on the
import path; backend tests also work via `cd backend && pytest` thanks to
`backend/pytest.ini` + `backend/conftest.py`).

---

## How the agent loop works

Each task goes through a real (gated) pipeline even in simulation:

```
observe  → plan  → validate  → risk     → execute  → verify
  │               │           │
 scan page     infer      check      Action Risk Engine:
 context       steps      intent     high-risk = WAITING gate (user approve)
                                        │
privacy firewall (PII/redact)           └─ approval → deferred steps run
```

- **Risk engine** (`security/riskEngine.ts`) escalates financial, destructive
  and credential actions to **high** — those never self-execute; the agent
  pauses and shows reasons in the confirm bar.
- **Privacy firewall** (`privacy/`) detects PII (email, phone, card, Aadhaar,
  PAN, SSN, IP, postal), redacts before anything leaves the page, and returns
  `ALERT` + block when financial-grade data is found.
- **BrowserAdapter** (`browser/`) is the only seam to the platform; Chrome and
  Firefox implementations live side by side, so the worker never touches
  `chrome`/`browser` globals directly.

### Messaging protocol

```
panel ──runtime.sendMessage──▶ background ──tabs.sendMessage──▶ active tab content script
        AGENT_HIGHLIGHT                            ─▶ glowing marker + label + beam
        AGENT_BEAM                                ─▶ beam toggle
        AGENT_INJECT_ACTION                       ─▶ real click / type / scroll / select
        AGENT_STATE                               ─▶ in-page status pill
        BROWSER_COMMAND  (newTab / closeTab / reload handled in background)
```

### The 3D robot

- Procedurally built (~40 primitives, no GLB, no textures) with PMREM studio
  reflections and selective UnrealBloom.
- An 8-state damped motion machine (IDLE → OBSERVING → THINKING → ACTING →
  SUCCESS / WAITING / PAUSED / ERROR) drives the body language.
- Adaptive pixel ratio, particle count and bloom disabled on low-power
  devices / `prefers-reduced-motion` / coarse pointers.

---

## Testing

```bash
npm test                                  # extension unit suites (vitest)
pytest backend/tests                      # backend gate + firewall + health (from repo root)
# or: cd backend && pytest
```

Covered today: PII detection/redaction, firewall verdicts, risk-engine
escalation & approval, planner lifecycle, guarded timeline (confirmation gates),
privacy redaction counts, and message routing.

## License

MIT