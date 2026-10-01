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

- **Project overview (start here):** [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md) — plain-language tour + end-to-end flow (diagrams: [docs/diagrams.html](./docs/diagrams.html))
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
- **Python usage (Hyper extract sidecar):** [docs/python-dependency-decision.md](./docs/python-dependency-decision.md)

It can also **Build a datasource** from **Salesforce**, **Excel**, **Google BigQuery**,
**Salesforce Data Cloud**, or **Snowflake** (relationships or physical joins; Live or Extract
where the source supports it — Excel is extract-only).

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

# (optional) for the extract-datasource builders — creates .venv-hyper with the
# Tableau Hyper API (Python). Needed for the Salesforce, Excel, BigQuery-extract, Data Cloud-extract, and Snowflake-extract connectors.
npm run setup:hyper
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
| `HYPER_PYTHON` | path to the Hyper API Python interpreter (defaults to `.venv-hyper`; Salesforce, Excel, BigQuery-extract, Data Cloud-extract, Snowflake-extract connectors) |
| `HYPER_MAX_ROWS` | cap on rows queried per table when materializing an extract (default `100000`) |
| `SALESFORCE_OAUTH_CLIENT_ID` / `SALESFORCE_OAUTH_CLIENT_SECRET` / `SALESFORCE_OAUTH_REDIRECT_URI` | Salesforce browser-OAuth for CRM **and** Data Cloud (optional; Data Cloud can paste the Connected App key in the UI). Data Cloud reuses this callback URI. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` | Google BigQuery browser-OAuth (**optional** — if unset, the UI asks for the Client ID/secret at sign-in and can save it encrypted in the user's vault; redirect defaults to `…/api/connectors/bigquery/oauth/callback`) |

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

1. **Vault** — register a username + 6-digit PIN (first time), then save Tableau
   credentials (cloud URL, site, PAT, optional Connected App) in the left-top Vault.
   Connector logins are saved from the connect forms (**Save Creds in Vault** /
   **Use Saved Creds**); Vault shows compact summaries and PIN delete (not Excel).
   The Vault header has **Show Vault** (body hidden by default after Tableau credentials
   are saved). Later: unlock with your PIN.
   Edit or delete Tableau credentials (PIN-gated). Tableau delete keeps your vault user
   and clears the whole blob.
2. **Connect & lock** — connect to Tableau Cloud, pick the **target project (folder)**,
   then **Use Published datasource** (datasources in that folder) or **Build datasource**
   (pick a connector; default is **Select the connector**), then **lock** (immutable for
   the session).
3. **Plan & create** — describe the dashboard. The agent inspects the locked
   datasource's real fields and returns a Zod-validated `DashboardPlan`. Review it,
   **approve**, then execute: the `.twb` is generated, published to the approved
   project, and **verified**. You get the real Tableau URL.
4. **Refine** — the published workbook opens in the **real** Web Authoring embed on the
   right. Finish anything in Category C by hand; saves are captured via the real
   `WorkbookPublished` events.

**Or build a Salesforce data source** — in the setup panel, connect to Salesforce
(username/password or OAuth; **Save Creds in Vault** / **Use Saved Creds**), pick one or more objects, optionally model them
(Relationship or Join) with join fields, then publish. The extract is materialized locally
(Hyper sidecar), published to your chosen project, and the saved Salesforce credential is
embedded + an extract refresh is triggered.

**Or build an Excel data source** — pick the **Excel** connector, upload an `.xlsx`, and its
**sheets** appear as the objects for the same Relationship/Join modeling. Publish to your chosen
project as an **extract-only** datasource — the workbook's data is bundled in a `.hyper` (no live
file connection, no embedded credential, no refresh). Uses the same Hyper sidecar as Salesforce.

**Or build a Google BigQuery data source** — pick **Google BigQuery**, enter the OAuth client
on Sign in if needed (**Save Creds in Vault** stores the client only), sign in with Google
(browser OAuth), pick Billing Project → Project → Dataset, model tables (Relationship or Join),
then choose **Live** or **Extract**. Extract uses the Hyper sidecar and a post-publish refresh;
Live publishes a bare `.tds`. Both embed your saved Google BigQuery OAuth credential on Tableau Cloud.

**Or build a Salesforce Data Cloud data source** — pick **Salesforce Data Cloud**, paste your
Salesforce **My Domain** URL, sign in with Salesforce (browser OAuth; **Save Creds in Vault** /
**Use Saved Creds**; a collapsible how-to covers the Connected App), pick a **Data Space** and
object type (DMO / DLO / Calculated Insights / All), model objects (Relationship or Join), then
choose **Live** or **Extract**. Extract uses the Hyper sidecar and a post-publish refresh; Live
publishes a bare `.tds`. Both embed your saved Salesforce Data Cloud OAuth credential on Tableau
Cloud.

**Or build a Snowflake data source** — pick **Snowflake**, sign in with server URL / warehouse /
username / password (**Save Creds in Vault** / **Use Saved Creds**), pick **Warehouse → Database → Schema**, model tables (Relationship or
Join), then choose **Live** or **Extract**. Extract uses the Hyper sidecar and a post-publish
refresh; Live publishes a bare `.tds`. Both embed the Snowflake username/password on the
Tableau Cloud connection.

**Interface** — a light, Tableau-themed two-pane layout: the AI workflow on the left and the
read-only published dashboard on the right. Use **Hide/Show dashboard** in the top bar to
collapse the preview and give the workflow full width, and the collapsible **Datasource
fields** and **Sheets & dashboards** sections to keep things tidy. After edits you get clear
status messages — "Modifications done — waiting for approval to build" for a revised plan, and
"Modification done and dashboard published successfully" after an in-place modify.

## Mastra Studio

`npm run dev:studio` runs `mastra dev`, exposing the same agent, tools, workflows, and
memory the API uses — useful for inspecting runs, structured output, and stepping the
`dashboardCreationWorkflow` (suspend/resume approval). See
[docs/architecture.md](./docs/architecture.md#two-runtimes-one-brain).

## API surface (BFF)

All routes are under `/api`. The browser sends only an opaque `x-session-id`; secrets
stay server-side.

- `POST /api/vault/register`, `POST /api/vault/unlock`, `POST /api/vault/logout`,
  `GET /api/vault/session`, `POST /api/vault/credentials`,
  `GET /api/vault/credentials`, `POST /api/vault/credentials/update`,
  `POST /api/vault/credentials/delete`,
  `POST /api/vault/connectors/{salesforce,bigquery,datacloud,snowflake}`,
  `POST /api/vault/connectors/{salesforce,bigquery,datacloud,snowflake}/delete`
- `POST /api/tableau/connect`, `GET /api/tableau/{projects,datasources,workbooks,views}`,
  `GET /api/tableau/datasource/:id/metadata`,
  `POST /api/tableau/{select-project,lock-datasource,unlock-datasource}`,
  `GET /api/tableau/context`
- `POST /api/dashboard/plan`, `GET /api/dashboard/plan`, `POST /api/dashboard/approve`,
  `POST /api/dashboard/execute`
- `GET /api/embed/info`
- `GET /api/connectors`, `POST /api/connectors/salesforce/{connect,describe,publish}`,
  `POST /api/connectors/salesforce/oauth/start`, `GET /api/connectors/salesforce/{tables,oauth/callback}`
- `POST /api/connectors/excel/upload` (multipart `.xlsx`/`.xlsm`), `POST /api/connectors/excel/publish` (extract-only)
- `POST /api/connectors/bigquery/oauth/start`, `GET /api/connectors/bigquery/{oauth/callback,status,projects,datasets,tables}`,
  `GET|POST /api/connectors/bigquery/oauth/client` (save/read the per-user OAuth client in the vault),
  `POST /api/connectors/bigquery/{describe,publish}` (Google BigQuery, **live or extract**)
- `POST /api/connectors/datacloud/oauth/start`, `POST /api/connectors/datacloud/connect`,
  `GET /api/connectors/datacloud/{dataspaces,objects}`,
  `POST /api/connectors/datacloud/{describe,publish}` (Salesforce Data Cloud, **live or extract**)
- `POST /api/connectors/snowflake/connect`, `GET /api/connectors/snowflake/{warehouses,databases,schemas,tables}`,
  `POST /api/connectors/snowflake/{describe,publish}` (Snowflake, **live or extract**)

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
