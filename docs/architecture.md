# Architecture — TableauPilot AI

> Living document. Update this whenever components, data flow, or key technical
> decisions change. Last updated: 2026-09-29.

TableauPilot AI is a Mastra-orchestrated agentic copilot for Tableau Cloud Web
Authoring. It follows a **hybrid authoring** strategy:

> AI plan → server-side `.twb`/`.twbx` generation → REST publish (creates a real
> dashboard) → embedded **real** Web Authoring for refinement → REST verification.

## 1. High-level diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser — React 18 SPA (Vite) + Tableau Embedding API v3             │
│   • holds ONLY an opaque x-session-id (never a secret)               │
│   • renders the 4-step flow + the REAL Web Authoring embed           │
└───────────────▲──────────────────────────────┬──────────────────────┘
                │  /api/*  (JSON, session id)   │  embed URL + short-lived JWT
                │                               ▼
┌───────────────┴──────────────────────────────────────────────────────┐
│ Backend BFF — Hono (src/server)                                       │
│  CORS · error boundary (sanitizeError) · requireSession middleware    │
│                                                                       │
│   Vault        Planning        Execution       Embed info             │
│   (PIN/AES)    (agent+Zod)     (guards)        (JWT/URL)              │
│      │             │               │               │                  │
│      └─────────────┴───────────────┴───────────────┘                  │
│                        │                                              │
│                        ▼                                              │
│   Tableau Service Layer (src/tableau) — the ONLY HTTP caller to TC    │
│   auth · discovery · datasources(MetadataAPI) · permissions ·         │
│   authoring(.twb/.twbx) · publishing · verification                   │
└───────────────────────┬───────────────────────────────────────────────┘
                        │ REST v3.24 + Metadata API (GraphQL)
                        ▼
              ┌────────────────────────┐
              │  Tableau Cloud site     │
              └────────────────────────┘

Mastra instance (src/mastra) ── `mastra dev` ──► Mastra Studio
   (same agent / tools / workflows / memory the API uses)
```

## 2. Components / layers (`src/`)

| Layer | Path | Responsibility |
|---|---|---|
| **config** | `config/env.ts` | Load `.env`, typed read-only config, redacted summary, boot validation. |
| **utils** | `utils/{redaction,logger,errors}.ts` | Deep redaction, structured redacting logger, `AppError` + `sanitizeError`. |
| **llm** | `llm/index.ts` | Provider-agnostic model resolution (Anthropic gateway or OpenRouter); custom fetch w/ key-helper + CA cert. |
| **vault** | `vault/*` | Per-user PIN-encrypted credential store + in-memory sessions + `VaultService`. |
| **schemas** | `schemas/*` | Zod schemas for the whole `DashboardPlan` contract. |
| **tableau** | `tableau/*` | The ONLY place that talks HTTP to Tableau. Client + `auth`, `discovery`, `datasources` (Metadata API), `permissions`, `authoring` (`.twb`/`.twbx` + Salesforce `.tds`), `publishing` (workbooks, Salesforce `.tdsx` via `hyperPackager`, connection embed/refresh), `verification`, and the `TableauService` façade (session-scoped). |
| **salesforce** | `salesforce/*` | Salesforce connectivity: SOAP `login` + REST `describe`/`query` + API-version auto-discovery (`client.ts`); browser OAuth PKCE (`oauth.ts`, `oauthStore.ts`). Session state is transient (in-memory). |
| **hyper sidecar** | `scripts/hyper/build_tdsx.py` | Python Hyper API script (only Python in the repo) that writes a `.hyper` and zips it with the `.tds` into a `.tdsx`; invoked as a subprocess by `tableau/publishing/hyperPackager.ts`. |
| **validation** | `validation/{fieldValidation,guards}.ts` | Field validation vs live metadata; deterministic guards (lock/project/approval). |
| **processors** | `processors/*` | LLM secret-protection input processor + guard re-exports. |
| **memory** | `memory/index.ts` | Mastra Memory (non-sensitive preferences only). |
| **observability** | `observability/index.ts` | Redacting spans/events. |
| **tools** | `tools/*` | Mastra tools: read-only discovery + planning/validation for the agent; publish/verify for the execution layer. |
| **agents** | `agents/*` | `tableauPilotAgent` (consultant persona) + `dashboardPlannerAgent` (tool-less JSON planner). |
| **planning** | `planning/index.ts` | NL → structured, validated `DashboardPlan`; approval. |
| **execution** | `execution/index.ts` | Runs only approved/validated publish + verify. |
| **workflows** | `workflows/*` | Phase workflows + orchestrating `dashboardCreationWorkflow` (suspend/resume approval). |
| **mastra** | `mastra/*` | The Mastra instance (`mastra dev` → Studio) + shared storage. |
| **server** | `server/*` | Hono BFF exposing `/api/*`; bootstrap + prod SPA serving. |

Frontend (`app/`): `App.tsx` orchestrator; `api.ts` typed client (stores only session
id); components `ConnectionPanel`, `CredentialsPanel`, `SetupPanel`, `PlanPanel`,
`AuthoringPanel`, `common`.

## 3. Data flow — the main path (`dashboardCreationWorkflow`)

```
validate session
  → validate project
  → validate + LOCK datasource (immutable)
  → load live metadata (Metadata API)
  → planner agent emits DashboardPlan (JSON)
  → Zod validation + field validation vs metadata
  → HUMAN APPROVAL (suspend/resume; hash-gated)
  → generate .twb  →  package .twbx
  → target-project guard
  → REST publish (skipConnectionCheck=true)
  → open embed for refinement (Category C handoff)
  → REST verify (site/project/workbook/view/datasource/URL)
  → return the ACTUAL Tableau URL
```

Session state (`session.flow`) carries: `projectContext`, `datasourceLock`, `plan`,
`approvedPlanHash`, `workbook`. All secrets stay in the session (in-memory) and the
encrypted vault.

## 3b. Data flow — Salesforce extract datasource (`buildAndPublishSalesforceDatasource`)

```
connect to Salesforce (username/password or OAuth) → auto-resolve REST API version
  → list objects  →  user models objects in SetupPanel (mode + relationships/joins)
  → describe each selected object (fields)
  → SOQL query each object (per-object row cap)
  → generate .tds  (single | relationships object-graph | physical join)
  → materialize .hyper + package .tdsx   (Python Hyper sidecar)
  → REST publish the .tdsx datasource to the chosen project
  → embed the saved Salesforce credential on the connection(s)  (best-effort)
  → trigger a server-side extract refresh                        (best-effort)
  → return { datasource, extract:{ state, message } }
```

Salesforce creds + live session live only on `session.connectors.salesforce` (in-memory)
and are cleared once publishing completes; the published datasource authenticates via the
**saved Salesforce credential** on Tableau Cloud, never an embedded password.

## 3c. Data flow — Excel extract-only datasource (`excelBuildAndPublishDatasource`)

The "Build datasource" flow is **connector-pluggable**: the modeling step is a shared
`DataModelBuilder` component, and the extract/publish pipeline is connector-agnostic. Excel
sheets play the exact role Salesforce objects play.

```
upload .xlsx  →  server parses it once (exceljs): sheets + typed columns + rows,
                 names sanitized to identifier-safe ids (stashed on session.connectors.excel)
  → user models SHEETS in the shared DataModelBuilder (mode + relationships/joins)
  → generate .tds  (single | relationships object-graph | physical join) via excelTdsGenerator
       (excel-direct connection + [Sheet$] relations; reuses the Salesforce .tds helpers)
  → materialize .hyper + package .tdsx   (SAME Python Hyper sidecar)
  → REST publish the .tdsx  EXTRACT-ONLY  (no connectionCredentials; no embed; no refresh)
  → lock datasource + cache sheet fields  →  converge on the normal dashboard flow
```

The uploaded workbook (schema + rows) lives only on `session.connectors.excel` (in-memory)
and is cleared once publishing completes. The published datasource is a static extract —
the bundled `.hyper` IS the data ("include external files → extract"); the `excel-direct`
`filename` is retained only for lineage and is never read on Tableau Cloud.

## 3d. Data flow — Google BigQuery datasource (`buildAndPublishBigQueryDatasource`)

The third connector plugs into the SAME pluggable "Build datasource" flow (shared
`DataModelBuilder`), but adds a **Live/Extract** choice. BigQuery tables play the role
Salesforce objects / Excel sheets play. Authentication is **browser Google OAuth** (PKCE);
the access/refresh token is held only on `session.connectors.bigquery` (in-memory).

```
Sign in with Google (OAuth popup)  →  server holds the access/refresh token in-memory
  → pick Billing Project > Project > Dataset  (Cloud Resource Manager + BigQuery REST)
  → user models TABLES in the shared DataModelBuilder (mode + relationships/joins)
  → describe each table (BigQuery REST)  [+ for EXTRACT: query rows via jobs.query]
  → generate .tds via bigqueryTdsGenerator  (class='bigquery' OAuth connection +
       [project.dataset].[table] relations; real column names kept as remote-name)
  → LIVE:    publish a bare .tds   (no <extract>)          →  embed Google OAuth cred
    EXTRACT: materialize .hyper + package .tdsx (Python sidecar) → publish → embed cred
             → server-side extract refresh (refreshDatasourceNow)
  → lock datasource + cache table fields  →  converge on the normal dashboard flow
```

The token is cleared once publishing completes. Both shapes embed the signed-in Google
account's **saved BigQuery OAuth credential** on Tableau Cloud (matched by email), so the
datasource is connectable/refreshable. LIVE runs nothing after publish (Tableau queries
BigQuery directly); EXTRACT triggers a refresh (best-effort — the bundled `.hyper` already
holds data queried at publish time).

## 4. Trust & secret boundaries

- **Browser** ↔ **BFF**: only an opaque `x-session-id` and non-secret payloads. Errors
  are sanitized (`sanitizeError`) before leaving.
- **BFF** ↔ **Tableau**: `TableauService`/`TableauClient` attach the session's Tableau
  token; never exposed to the client or LLM.
- **LLM**: receives plan requests + non-secret metadata only; guarded by a
  secret-protection input processor.
- **Embed JWT**: the only token intended for the browser — short-lived Connected App
  Direct-Trust JWT for the authoring viz.

## 5. Key technical decisions

- **Hybrid authoring over a fake editor.** Tableau's Embedding JS API cannot
  programmatically build vizzes; we generate a workbook + publish + verify, then embed
  the real editor. (See [authoring-limitations.md](./authoring-limitations.md).)
- **Server-side vault with PIN KDF.** `scrypt(PIN + server pepper + per-user salt)` →
  AES-256-GCM. PIN never leaves the server; pepper is process-only. (See
  [security.md](./security.md).)
- **Tool-less planner agent + JSON prompt injection.** Mastra's native structured
  output isn't universally supported by Anthropic-compatible gateways, so planning uses
  a dedicated JSON-only agent with robust fallback extraction.
- **Deterministic guards outside the LLM.** Datasource lock, project match, and approval
  hash are enforced in code, not by the model.
- **Published-datasource binding.** Generated workbooks reference the published
  datasource via `<repository-location>` + a fully-attributed `sqlproxy` connection, and
  publish with `skipConnectionCheck=true`. (Evolving — see [memory.md](./memory.md).)
- **`.twbx` packaging.** The `.twb` is zipped into a `.twbx` (via `fflate`) and uploaded
  as the standard packaged format.
- **Two runtimes, one brain.** The API server and Mastra Studio import the same agent,
  tools, workflows, and service layer.
- **TypeScript/Node, with one narrow Python exception.** Everything is TS/Node except a
  Python **Hyper API sidecar** (`scripts/hyper/build_tdsx.py`) used solely to materialize
  Salesforce `.hyper` extracts (the Hyper API has no Node binding). (See
  [python-dependency-decision.md](./python-dependency-decision.md).)
- **Salesforce extract datasources.** A second entry point connects to Salesforce, builds
  a `.tds` (single / relationships / physical-join) + a locally-materialized `.hyper`
  extract, publishes the `.tdsx`, then embeds the saved Salesforce credential and triggers
  an extract refresh. (See [design.md](./design.md) §5b and [memory.md](./memory.md).)

## 6. Two runtimes, one brain

The API server and Mastra Studio (`mastra dev`) share the same agent, tools, workflows,
and service layer. Studio is used to inspect agent runs, tool calls, structured output,
memory, and to run/resume the workflow during development. Server-side sessions are
in-memory in the process that owns them (the API server); to exercise a session-bound
workflow from Studio, provide a `sessionId` present in the Studio process.

## 7. Tech stack

TypeScript · Node ≥ 20.9 · Mastra (`@mastra/core` + memory/libsql/loggers) · Hono BFF ·
React 18 + Vite SPA · Zod · LibSQL (Mastra storage) · `fflate` (zip) · `undici` (fetch)
· Vitest · Playwright. Full API surface is documented in [design.md](./design.md).
