# Engineering & AI Rules — TableauPilot AI

> **Binding** rules for anyone (human or AI) working in this repo. Update this whenever
> an invariant, convention, or constraint changes. Last updated: 2026-09-30.

## 1. Tech to use / avoid

**Use**
- **TypeScript / Node.js ≥ 20.9** for everything.
- **Mastra** (`@mastra/core`, memory, libsql, loggers) for agents/tools/workflows.
- **Hono** for the BFF; **React 18 + Vite** for the SPA.
- **Zod** for all structured LLM output and boundary validation.
- **`undici`** fetch, **`fflate`** for zip, **LibSQL** for Mastra storage.
- **`exceljs`** to parse uploaded `.xlsx`/`.xlsm` workbooks (Excel connector only).
- **Vitest** (unit/integration) + **Playwright** (E2E, non-destructive).

**Avoid**
- **No Python except the one sanctioned Hyper sidecar** (`scripts/hyper/build_tdsx.py`,
  used only to materialize the Build-datasource connectors' `.hyper` extracts (Salesforce,
  Excel, BigQuery **extract** mode, Data Cloud **extract** mode, and Snowflake **extract**
  mode) — the Hyper API has no Node binding). Do not spread Python anywhere else (see
  [python-dependency-decision.md](./python-dependency-decision.md)).
- **No fake authoring** — do not simulate shelf/mark/filter edits via the Embedding JS
  API; Tableau does not support it (see [authoring-limitations.md](./authoring-limitations.md)).
- **No heavy/unnecessary dependencies.** Prefer stdlib + the minimal set above.
- **No hardcoded** Tableau projects/datasources/fields — discover live per session.
- **No storing user Tableau secrets** in `.env`, the browser, or localStorage.

## 2. Hard invariants (never violate)

1. **Secrets never leave the server.** No Tableau PAT/token, Connected App secret, or
   gateway key may reach the browser or the LLM. The browser holds only an opaque
   `x-session-id`. The only browser-bound token is the short-lived embed JWT.
2. **Datasource lock is immutable** for a session once set (`assertDatasourceLock`).
3. **Target-project match** is enforced before publish (`assertProjectMatch`).
4. **No publish without approval.** The approval hash must match the plan
   (`assertApproved`); approval is a human action.
5. **No fabricated fields.** Every field in a plan must exist in live metadata
   (`validatePlanFields`) before generation/publish.
6. **No unverifiable success.** A 2xx publish is not proof; success requires REST
   verification (`verifyWorkbook`).
7. **Guards live in code, not the model.** Deterministic guards are enforced in
   `src/validation`, never delegated to the LLM.
8. **`TableauService`/`TableauClient` is the only HTTP path to Tableau.** No other module
   calls Tableau directly. (Salesforce HTTP — SOAP login, REST describe/query, OAuth —
   is isolated in `src/salesforce/*`; BigQuery HTTP — Google OAuth + BigQuery/Cloud
   Resource Manager REST — is isolated in `src/bigquery/*`; Data Cloud HTTP — CDP token
   exchange, data spaces, metadata, Query API — is isolated in `src/datacloud/*` and
   **imports** Salesforce `login` without modifying it; Snowflake HTTP — session login +
   SHOW/DESCRIBE/SELECT — is isolated in `src/snowflake/*`; none of these talk to Tableau.)
9. **Connector source credentials (tokens) are never persisted.** Salesforce creds, the
   Google BigQuery OAuth **access/refresh token**, the Data Cloud SOAP session + CDP
   token, and the Snowflake session token + password are held transiently in-memory
   (`session.connectors.{salesforce,bigquery,datacloud,snowflake}`
   + the short-lived pending-OAuth state) only to read schema/data (and, for extracts, to
   build the local `.hyper`), then cleared after publish.
   The BigQuery OAuth **client** id/secret (the app-registration credential, NOT a user token —
   analogous to the Tableau Connected App secret) may be supplied in the UI and optionally saved
   **encrypted in the user's vault** (`TableauCredentials.bigQueryOAuth`) so it need not be
   re-entered; `GOOGLE_OAUTH_*` is an optional server-wide fallback. The signed-in Google email is
   fetched from OpenID `userinfo` (never asked of the user) and used as the connection username +
   Tableau saved-credential match. No user secret is ever written to `.env`, the browser, or logs.
   Published Salesforce / BigQuery / Data Cloud datasources authenticate via the saved OAuth
   credential on Tableau Cloud; Snowflake datasources authenticate via the **embedded username/
   password** sent at publish (not a saved OAuth credential). Multi-object `.tds` field names are qualified/disambiguated so they never
   collide (`[Object.Field]` for Salesforce/Excel; `Name`/`Name (Table)` for BigQuery; real API
   names with `Name (Caption)` collisions for Data Cloud, which also keeps the REAL field API
   name as `remote-name`; `{TABLE} ({DATABASE}.{TABLE})_{hash}` object-ids and `Name (TABLE)`
   collisions for Snowflake, which uses `authentication='Username Password'`).
10. **The conversational copilot stays in scope.** `tableauPilotAgent` only assists with
    this product (Tableau dashboards, the locked datasource/fields, the
    Salesforce/Excel/BigQuery/Data Cloud/Snowflake connector builds, and the app workflow); it politely declines
    and redirects off-topic requests (general knowledge, unrelated code, chit-chat) rather
    than answering them.

## 3. Security rules

- Derive keys with `scrypt(PIN + server pepper + per-user salt)`; encrypt at rest with
  **AES-256-GCM**. The **PIN never leaves the server**; the **pepper** is process-only.
- PIN gate all credential changes (same lockout/rate-limit as login:
  `VAULT_MAX_ATTEMPTS`, `VAULT_LOCKOUT_SECONDS`).
- On credential update, call `resetTableauState()` (drop token + flow).
- All logs/errors pass through **redaction** (`utils/redaction.ts`,
  `utils/logger.ts`). Never `console.log` secrets or raw request bodies.
- LLM input is scanned by the **secret-protection processor**; abort on secret patterns.
- Sessions are in-memory with a TTL sweeper (`SESSION_TTL_SECONDS`).

## 4. Error handling rules

- Throw **`AppError(code, message, { details?, hint? })`**; never leak internals.
- Client boundary must return **`sanitizeError()`** output only (deep-redacted details,
  code→status mapping).
- For Tableau failures, surface the **numeric subcode** (`Tableau API error (<status>
  [<code>])`) and an **actionable hint**; log a **redacted raw body preview** for
  diagnosis. Do **not** assume a permissions message means a permissions cause (e.g.
  `403 [500000]` is an internal error, not authz).
- Prefer **honest, specific** errors over generic ones (name the schema field, the
  missing capability, the `unavailableReason`, etc.).

## 5. Tableau authoring / publishing conventions

- Generated workbooks reference the **published datasource** via
  `<repository-location id=<contentUrl> path='/t/<site>/datasources' site=<site>/>` plus
  a fully-attributed `<connection class='sqlproxy'>` and a linked `<relation>`.
- Package the `.twb` into a **`.twbx`** (`packageTwbx`) and publish that.
- Publish with **`skipConnectionCheck=true`**; do **not** send a `workbookType` query
  param (file type comes from the filename).
- Treat `.twb`/`.twbx` generation as **best-effort scaffolding**; binding is finalized in
  the real Web Authoring embed. Never claim pixel-perfect fidelity.
- **Salesforce extract datasources:** generate the `.tds` deterministically in TypeScript
  (`tdsGenerator.ts`) — single, relationships (object-graph + cardinality), or physical
  join (`<relation type='join'>`). Materialize the `.hyper` locally via the Python sidecar
  and publish the `.tdsx`. After publish, embed the saved credential + trigger a refresh
  (best-effort; never fail the publish). All XML is code-generated, never LLM-generated.
- **Excel extract-only datasources:** generate the `.tds` deterministically in
  `excelTdsGenerator.ts` (a `class='excel-direct'` connection + `[<sheet>$]` relations,
  **reusing** the connection-agnostic `tdsGenerator.ts` helpers — do NOT fork Salesforce
  logic). Sheets are the "objects"; sheet/column names are sanitized to identifier-safe ids.
  Publish **extract-only**: NO `connectionCredentials`, NO credential embed, NO refresh — the
  bundled `.hyper` is the data. Never change Salesforce datasource logic to add Excel.
- **Google BigQuery datasources (live or extract):** generate the `.tds` deterministically in
  `bigqueryTdsGenerator.ts` (a `class='bigquery'` OAuth connection with
  `CATALOG`/`EXECCATALOG`/`project`/`schema`, and `[project.dataset].[table]` relations),
  reconciled 1:1 against `reference/BigQueryDataset{Live,Extract}.tds`. BigQuery column names
  may contain spaces/hyphens, so this generator writes its OWN `<cols>`/`<metadata-records>`/
  `<column>`/`<object-graph>` (keeping the REAL name as `remote-name`/`remote-alias` and a
  disambiguated `local-name`) instead of the identifier-only shared helpers. **Live** publishes
  a bare `.tds` (no `<extract>`, manifest omits `ObjectModelExtractV2`) and does nothing after
  embedding the OAuth credential. **Extract** materializes rows into a `.hyper` (Python sidecar,
  hyper table = the per-table object-id) and, after publish, embeds the Google OAuth credential
  + triggers a refresh (best-effort). Both embed the saved Google BigQuery OAuth credential
  (matched by the signed-in email). Never change Salesforce/Excel datasource logic to add BigQuery.
- **Salesforce Data Cloud datasources (live or extract):** generate the `.tds` deterministically in
  `dataCloudTdsGenerator.ts` (a `class='salesforce-genie'` OAuth connection with
  `dbname='a360/{pod}/{tenantId};{dataSpace}'`, `warehouse` = data space, `server` = `*.c360a.salesforce.com`,
  `instanceurl` = org URL, and `[public].[apiName]` relations with the friendly caption as the
  relation name), reconciled 1:1 against `reference/DataCloud{Live,Extract}DS.tds`. **Do not reuse
  `generateSalesforceTds`** (wrong class, wrong relation, wrong object-id). Column rule is like
  BigQuery: REAL field API names as `remote-name`; colliding `local-name`s become
  `ssot__Id__c (Account Contact)`. Object-id is `{caption}_{MD5(apiName)}` (spaces kept).
  **Live** publishes a bare `.tds` (no `<extract>`, manifest omits `ObjectModelExtractV2`,
  object-graph `context=''` only) and does not refresh. **Extract** materializes rows into a
  `.hyper` (Python sidecar, hyper table = that object-id) and, after publish, embeds the saved
  Salesforce Data Cloud OAuth credential + triggers a refresh (best-effort). Isolation:
  `src/datacloud/*` + this generator; never change Salesforce/Excel/BigQuery connector logic to
  add Data Cloud. Nested/complex fields are skipped (scalar columns only).
- **Snowflake datasources (live or extract):** generate the `.tds` deterministically in
  `snowflakeTdsGenerator.ts` (a `class='snowflake'` Username Password connection with
  `server`/`dbname`/`schema`/`warehouse`, and `[DATABASE].[SCHEMA].[TABLE]` relations),
  reconciled 1:1 against `reference/Snowflake{Live,Extract}DS.tds`. **Do not reuse**
  `generateSalesforceTds` / BigQuery / Data Cloud generators. Column rule is like BigQuery:
  REAL names as `remote-name`; colliding `local-name`s become `Region (PEOPLE)`. Object-id is
  `{TABLE} ({DATABASE}.{TABLE})_{MD5(db.schema.table)}` (stable vs the Hyper table name;
  Desktop's trailing hash is a different proprietary value). **Live** publishes a bare `.tds`
  (no `<extract>`, no refresh). **Extract** materializes rows into a `.hyper` (Python sidecar,
  hyper table = that object-id) and, after publish, embeds username/password and triggers a
  refresh (best-effort). Isolation: `src/snowflake/*` + this generator; never change
  Salesforce/Excel/BigQuery/Data Cloud connector logic to add Snowflake.

## 6. Coding conventions

- **Strict TypeScript** (ES2022, `moduleResolution: bundler`, JSX `react-jsx`). Keep
  `tsc --noEmit` clean.
- ESM imports use explicit `.js` extensions for local modules.
- Small, single-purpose modules with doc-comments explaining the *why* (esp. security &
  Tableau quirks). Match the existing comment style.
- Keep the redacting logger + `AppError` patterns; don't introduce ad-hoc logging.
- Tests accompany non-trivial logic; **do not** add a test just to test a trivial edit.
- **Keep `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` green.**

## 7. Documentation rule (ALL Markdown docs)

Every `.md` file in this repo is a **living document**. On **any** change to code,
schemas, APIs, config, UI, or behavior, update **all** affected docs **in the same
change** — this is part of the definition of done, enforced by the always-apply Cursor
rule [`.cursor/rules/keep-docs-updated.mdc`](../.cursor/rules/keep-docs-updated.mdc).
Verify facts against the code first, and bump each edited doc's `Last updated:` date.

- **prd.md** — scope/goals/requirements/success criteria.
- **architecture.md** — components, data flow, key decisions.
- **design.md** — module interfaces, schemas, algorithms, API routes, snippets.
- **rules.md** — invariants/conventions/security/error handling.
- **phases.md** — build plan + "done" criteria + test count.
- **memory.md** — append a newest-first progress-log entry (decisions, fixes, status).
- **README.md** — setup, env vars, run/usage, API surface.
- **PROJECT_OVERVIEW.md** — plain-language tour (keep in sync with connectors/flows).
- **security.md**, **authentication.md**, **tableau-api-capabilities.md**,
  **authoring-limitations.md**, **python-dependency-decision.md** — when their topic is
  touched.
