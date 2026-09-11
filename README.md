# TableauPilot AI

An agentic AI copilot for **Tableau Cloud Web Authoring**, built on
[Mastra](https://mastra.ai). You describe a dashboard in natural language;
TableauPilot plans it against your **real** datasource metadata, gets your approval,
generates a real workbook, **publishes it to Tableau Cloud via REST**, opens the
**real** Web Authoring embed for refinement, and **verifies** the result — returning the
actual Tableau URL. Secrets live in a **per-user, 6-digit-PIN-encrypted server-side
vault** and never reach the browser or the LLM.

> **Hybrid authoring:** AI plan → server-side `.twb` generation → REST publish → embedded
> **real** Web Authoring → REST verification. No fake editor, no fabricated success.

- **Product requirements:** [docs/prd.md](./docs/prd.md)
- **Architecture:** [docs/architecture.md](./docs/architecture.md)
- **Detailed design:** [docs/design.md](./docs/design.md)
- **Engineering & AI rules:** [docs/rules.md](./docs/rules.md)
- **Build plan (phases):** [docs/phases.md](./docs/phases.md)
- **Progress log:** [docs/memory.md](./docs/memory.md)
- **What's automatable (and what isn't):** [docs/tableau-api-capabilities.md](./docs/tableau-api-capabilities.md)
- **Authoring limits (Category C):** [docs/authoring-limitations.md](./docs/authoring-limitations.md)
- **Authentication:** [docs/authentication.md](./docs/authentication.md)
- **Security & the PIN vault:** [docs/security.md](./docs/security.md)
- **Why no Python:** [docs/python-dependency-decision.md](./docs/python-dependency-decision.md)

## Requirements

- Node.js ≥ 20.9
- A Tableau Cloud site + a **Personal Access Token** (PAT)
- (Optional) a Tableau **Connected App (Direct Trust)** for seamless embed auth
- An LLM provider: an Anthropic-compatible gateway **or** OpenRouter

## Setup

```bash
npm install
cp .env.example .env
# edit .env — set VAULT_PEPPER (long random), LLM provider + key, Tableau API version
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # for VAULT_PEPPER
```

Key env vars (full list + comments in [.env.example](./.env.example)):

| Var | Purpose |
|---|---|
| `LLM_PROVIDER` | `anthropic` or `openrouter` |
| `LLM_MODEL` | agent model id |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` \| `ANTHROPIC_API_KEY_HELPER` / `ANTHROPIC_CA_CERT` | Anthropic gateway |
| `OPENROUTER_API_KEY` | OpenRouter fallback |
| `TABLEAU_API_VERSION` | e.g. `3.24` |
| `VAULT_PEPPER` | **required** server-only pepper for the PIN KDF |
| `DATA_PATH` | encrypted vault + storage dir (git-ignored) |
| `API_PORT` / `WEB_PORT` / `CORS_ORIGINS` | app wiring |

Per-user **Tableau credentials are never in `.env`** — you enter them in the app and
they're stored in the encrypted vault.

## Run

```bash
npm run dev          # API server (:4000) + Vite web UI (:5173) together
# or individually:
npm run dev:server   # Hono BFF (tsx watch)
npm run dev:web      # Vite SPA
npm run dev:studio   # Mastra Studio (mastra dev) — inspect agent/tools/workflows
```

Open the web UI (default http://localhost:5173). The Vite dev server proxies `/api` to
the backend.

### Production

```bash
npm run build        # typecheck + build SPA to dist/web
npm start            # NODE_ENV=production; serves API and the built SPA
```

## Using it

1. **Vault** — register a username + 6-digit PIN (first time), then save your Tableau
   credentials (cloud URL, site, PAT, optional Connected App). Later: unlock with your
   PIN.
2. **Connect & lock** — connect to Tableau Cloud, pick the **target project**, pick and
   **lock** a published datasource (immutable for the session).
3. **Plan & create** — describe the dashboard. The agent inspects the locked
   datasource's real fields and returns a Zod-validated `DashboardPlan`. Review it,
   **approve**, then execute: the `.twb` is generated, published to the approved
   project, and **verified**. You get the real Tableau URL.
4. **Refine** — the published workbook opens in the **real** Web Authoring embed on the
   right. Finish anything in Category C by hand; saves are captured via the real
   `WorkbookPublished` events.

## Mastra Studio

`npm run dev:studio` runs `mastra dev`, exposing the same agent, tools, workflows, and
memory the API uses — useful for inspecting runs, structured output, and stepping the
`dashboardCreationWorkflow` (suspend/resume approval). See
[docs/architecture.md](./docs/architecture.md#two-runtimes-one-brain).

## API surface (BFF)

All routes are under `/api`. The browser sends only an opaque `x-session-id`; secrets
stay server-side.

- `POST /api/vault/register`, `POST /api/vault/unlock`, `POST /api/vault/logout`,
  `GET /api/vault/session`, `POST /api/vault/credentials`
- `POST /api/tableau/connect`, `GET /api/tableau/{projects,datasources,workbooks,views}`,
  `GET /api/tableau/datasource/:id/metadata`,
  `POST /api/tableau/{select-project,lock-datasource,unlock-datasource}`,
  `GET /api/tableau/context`
- `POST /api/dashboard/plan`, `GET /api/dashboard/plan`, `POST /api/dashboard/approve`,
  `POST /api/dashboard/execute`
- `GET /api/embed/info`

## Testing

```bash
npm run typecheck
npm run lint
npm test             # vitest unit + integration
npm run test:e2e     # Playwright (non-destructive)
```

## Limitations (read this)

TableauPilot is honest about capability boundaries. Programmatic shelf/mark/filter
manipulation via the embedding JS API is **not supported by Tableau** and is never
faked — it's handed to you in the real embed. Generated `.twb` workbooks are
best-effort and may need field re-binding/tuning. See
[docs/authoring-limitations.md](./docs/authoring-limitations.md).
