# Architecture

TableauPilot AI is a Mastra-orchestrated agentic copilot for Tableau Cloud Web
Authoring. It follows a **hybrid authoring** strategy:

> AI plan → server-side `.twb` generation → REST publish (creates a real dashboard)
> → embedded **real** Web Authoring for refinement → REST verification.

## Components

```
Browser (React SPA, Embedding API v3)
   │  /api/*  (opaque session id only — never a secret)
   ▼
Backend API (Hono, src/server)  ─────────────┐
   │              │                 │         │
   ▼              ▼                 ▼         ▼
Vault        Planning          Execution   Embed info
(PIN/AES)    (agent+Zod)       (guards)    (JWT/URL)
   │              │                 │
   └──────────────┴─────────────────┘
                  ▼
        Tableau Service Layer (src/tableau)
                  ▼
        Tableau Cloud (REST + Metadata API)

Mastra instance (src/mastra) ── mastra dev ──► Mastra Studio
   (same agent / workflows / tools / memory the API uses)
```

## Layers (`src/`)

- **config** — env loading + redacted config summary; boot validation.
- **utils** — redaction, structured logger, error types + sanitization.
- **llm** — provider-agnostic model resolution (Anthropic gateway or OpenRouter),
  key-helper + CA-cert support. Returns a Mastra language model.
- **vault** — per-user PIN-encrypted credential store + in-memory sessions.
- **schemas** — Zod schemas for the whole `DashboardPlan` contract.
- **tableau** — the ONLY place that talks HTTP to Tableau: `tableauClient`, `auth`,
  `discovery`, `datasources` (Metadata API), `permissions`, `authoring`
  (`.twb` generation + web-edit URLs), `publishing`, `verification`, plus the
  `TableauService` façade (operates on a session).
- **validation** — field validation vs live metadata + deterministic guards
  (datasource lock, target-project, approval).
- **processors** — LLM secret-protection input processor + guard re-exports.
- **memory** — Mastra Memory (non-sensitive preferences only).
- **observability** — redacting spans/events.
- **tools** — Mastra tools (read-only discovery + planning/validation for the agent;
  publish/verify for the execution layer).
- **agents** — `tableauPilotAgent` (consultant persona).
- **planning** — NL → structured, validated `DashboardPlan`.
- **execution** — runs only approved/validated publish + verify.
- **workflows** — phase workflows + the orchestrating `dashboardCreationWorkflow`
  (suspend/resume human approval gate).
- **mastra** — the Mastra instance (`mastra dev` → Studio) + shared storage.
- **server** — the Hono BFF exposing `/api/*`.

## Main flow (`dashboardCreationWorkflow`)

validate session → validate project → validate + **lock datasource** → load metadata
→ agent generates `DashboardPlan` → **Zod validation** + field validation →
**human approval (suspend/resume)** → generate `.twb` → **target-project guard** →
REST publish → open embed for refinement (Category C handoff) → REST **verify**
(site/project/workbook/view/datasource/URL) → return the **actual** Tableau URL.

## Two runtimes, one brain

The API server and Mastra Studio import the same agent, tools, workflows, and service
layer. Studio (`mastra dev`) is used to inspect agent runs, tool calls, structured
output, memory, and to run/resume workflows during development.

Note: server-side sessions are in-memory in the process that owns them (the API
server). To exercise a session-bound workflow from Studio, provide a `sessionId`
present in the Studio process.
