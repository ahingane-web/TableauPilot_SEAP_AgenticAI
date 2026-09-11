# Design — TableauPilot AI

> Living document. Update this whenever module interfaces, schemas, algorithms, or
> code-level decisions change. Last updated: 2026-09-09.

This is the module-level design. For the big picture see
[architecture.md](./architecture.md); for binding rules see [rules.md](./rules.md).

---

## 1. Config (`src/config/env.ts`)

- Minimal dependency-free `.env` loader (only sets unset vars).
- `getConfig()` returns a cached, typed, read-only `AppConfig` (llm / tableau / vault /
  app). `describeConfig()` returns a **redacted** summary. `assertBootConfig()` throws
  actionable, secret-free errors for missing pepper / LLM keys.
- User Tableau secrets are **never** read here — they live in the vault.

## 2. Vault (`src/vault/*`)

**Crypto (`crypto.ts`)**
- `deriveKey(pin, salt)` → `scrypt(PIN + pepper, salt)` (AES-256 key).
- `encrypt/decrypt` → AES-256-GCM (iv + authTag + ciphertext).
- `makeVerifier/checkVerifier` → validate a PIN without storing it.
- `isValidPin` → exactly 6 digits.

**Types (`types.ts`)**: `TableauCredentials` (secret), `CredentialSummary` (non-secret),
`VaultRecord`; `summarizeCredentials()` strips secrets.

**Store (`store.ts`)**: JSON file at `DATA_PATH/vault.json`, mode `0o600`; created dir
`0o700`.

**Session (`session.ts`)**: in-memory `Session { id, username, vaultKey, credentials,
tableauAuth, flow }`; `createSession/getSession/destroySession/startSessionSweeper`.

**Service (`vault.ts`)** — `VaultService` singleton:
- `register`, `unlock` (lockout after `VAULT_MAX_ATTEMPTS`, `VAULT_LOCKOUT_SECONDS`),
  `saveCredentials`, `updateCredentials` (PIN-gated; shares `verifyPinOrThrow`),
  `getCredentialSummary`, `logout`, `requireSession`.
- `resetTableauState(session)` clears `tableauAuth` + `flow` on credential update
  (forces reconnect with new creds).

## 3. LLM (`src/llm/index.ts`)

- Resolves a Mastra language model from config: Anthropic-compatible gateway
  (`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` or `..._API_KEY_HELPER`, optional
  `ANTHROPIC_CA_CERT`) **or** OpenRouter (`OPENROUTER_API_KEY`).
- Custom `fetch` injects auth (static key or helper command output) and a CA cert when
  provided.

## 4. Schemas (`src/schemas/*`, Zod)

- `common.ts`: `ChartType` (20 types), `FilterOperator`, `FieldRole`, `Aggregation`,
  `DatasourceReference`, `TableauProjectContext`, `DatasourceLock`, `SortingSpec`,
  `FormattingSpec`.
- `dashboardPlan.ts`: `DashboardPlanSchema` (full) and `DashboardPlanDraftSchema` (omits
  `publishing` + `datasource`, injected server-side).
- Domain specs: `worksheetSpec`, `calculatedFieldSpec`, `filterSpec`, `parameterSpec`,
  `dashboardLayoutSpec`, `publishingSpec`.

**Decision:** the LLM produces a *draft* (no publishing/datasource). The server injects
the locked datasource + approved project so the model can't redirect output.

## 5. Tableau service layer (`src/tableau/*`)

**Client (`tableauClient.ts`)** — low-level REST/GraphQL:
- `signIn` (PAT), `get`, `postJson`, `metadataGraphql`, `postMultipart`.
- Non-2xx → logs a redacted raw body preview, extracts Tableau's numeric **subcode**,
  throws `AppError('TABLEAU_API', 'Tableau API error (<status> [<code>]): <msg>')` with
  a subcode-aware hint (`hintForTableauError`). 401 → `AUTH_FAILED`.
- Non-JSON 2xx (HTML/login wall) → diagnostic error with content-type + body preview.

```221:237:src/tableau/tableauClient.ts
function extractTableauError(text: string): { code?: string; message: string } {
  // parses error.code (JSON) or <error code='…'> (XML) + summary/detail, redacted
}
```

**Auth (`auth/index.ts`)**: `signIn` wrapper; `mintConnectedAppJwt` (HMAC-SHA256 Direct
Trust); `normalizeCloudUrl` reduces any input to `new URL(...).origin`.

**Discovery (`discovery/index.ts`)**: projects/workbooks/views/datasources
(pagination-aware); datasource objects carry `contentUrl`.

**Datasources / Metadata (`datasources/index.ts`)**: GraphQL query reads
`remoteField { dataType, role }` inside `DatasourceField`; returns
`metadataApiAvailable` + `unavailableReason` on failure (redacted diagnostics).

**Permissions (`permissions/index.ts`)**: advisory checks (project publish, datasource
access, workbook edit). Explicit Deny → blocked; explicit Allow → allowed; no grant →
allowed-but-indeterminate (Tableau Cloud enforces on the real op).

**Authoring**
- `twbGenerator.ts` — `generateTwb(plan, metadata, opts?: { siteContentUrl })` compiles
  plan → `.twb`. Datasource block emits `<repository-location>` (published-datasource
  binding) + a fully-attributed `<connection class='sqlproxy'>` + `<relation>`.

```105:140:src/tableau/authoring/twbGenerator.ts
function renderDatasource(plan, metadata, siteContentUrl?) {
  // <repository-location id=<contentUrl> path='/t/<site>/datasources' site=<site>/>
  // <connection class='sqlproxy' dbname schema server directory channel port username>
  //   <relation connection=<dsName> name=<caption> table='[<caption>]' type='table'/>
}
```

- `twbxPackager.ts` — `packageTwbx(twbXml, workbookName)` zips the `.twb` at archive
  root via `fflate.zipSync`, returns a `Buffer`.

**Publishing (`publishing/index.ts`)**: builds `request_payload` XML (name/project),
packages `.twbx`, `POST /sites/{site}/workbooks?overwrite=…&skipConnectionCheck=true`
multipart (`request_payload` + `tableau_workbook`), returns the created workbook.

**Verification (`verification/index.ts`)**: GETs the published workbook, resolves the
real Tableau URL, checks project match.

**Façade (`index.ts`)** — `TableauService` (session-scoped): lazy auth (token cached 55
min), discovery, metadata, `setProjectContext`, `lockDatasource`/`unlockDatasource`,
permission checks, `publishPlan` (runs guards → generate → package → publish), verify,
`getEmbedInfo`.

```156:189:src/tableau/index.ts
async publishPlan(session, plan, metadata) {
  assertDatasourceLock(...); assertProjectMatch(...); assertApproved(...);
  // check project publish
  const twb = generateTwb(plan, metadata, { siteContentUrl: requireAuth(session).siteContentUrl });
  // log redacted datasource binding block
  return publishWorkbook(getClient(session), {...});
}
```

## 6. Validation & guards (`src/validation/*`)

- `fieldValidation.ts`: `validatePlanFields(plan, metadata)` extracts fields from
  shelves/filters/formulas and checks them against live metadata; returns errors +
  available alternatives.
- `guards.ts`: `hashPlan` (SHA-256, stable), `assertDatasourceLock`,
  `assertProjectMatch`, `assertApproved`.

## 7. Planning & execution

- `planning/index.ts`: `generateDashboardPlan(session, request)` →
  `generatePlanDraft()` (tool-less `dashboardPlannerAgent`, `jsonPromptInjection:
  'system'`, `extractJsonObject()` fallback) → inject datasource/publishing → Zod +
  field validation → store draft plan + hash in session. `approvePlan(session, hash)`
  validates the approval hash.
- `execution/index.ts`: `runPublishAndVerify(session)` → `getMetadata` →
  `TableauService.publishPlan` → `verifyWorkbook`; emits redacting spans/events.

## 8. Server (`src/server/app.ts`)

Hono BFF; CORS from `CORS_ORIGINS`; central `onError` → `sanitizeError`;
`requireSession` reads `x-session-id`. Full route table:

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| POST | `/api/vault/register` | create user + PIN |
| POST | `/api/vault/unlock` | unlock (PIN) → session id |
| POST | `/api/vault/logout` | destroy session |
| GET | `/api/vault/session` | context snapshot |
| POST | `/api/vault/credentials` | save Tableau creds |
| GET | `/api/vault/credentials` | non-secret summary |
| POST | `/api/vault/credentials/update` | PIN-gated update |
| POST | `/api/tableau/connect` | PAT sign-in |
| GET | `/api/tableau/{projects,datasources,workbooks,views}` | discovery |
| GET | `/api/tableau/datasource/:id/metadata` | metadata (dims/measures/dates) |
| POST | `/api/tableau/select-project` | set target project |
| POST | `/api/tableau/lock-datasource` | lock datasource |
| POST | `/api/tableau/unlock-datasource` | unlock |
| GET | `/api/tableau/context` | context snapshot |
| POST | `/api/dashboard/plan` | NL → plan |
| GET | `/api/dashboard/plan` | current plan |
| POST | `/api/dashboard/approve` | approve by hash |
| POST | `/api/dashboard/execute` | publish + verify |
| GET | `/api/embed/info` | embed URL + optional JWT |

Client returns a sanitized error envelope `{ error: { code, message, hint?, details? } }`.

## 9. Frontend (`app/*`)

`api.ts` stores only the session id (localStorage) and injects `x-session-id`; `App.tsx`
renders the 4-step flow from the context snapshot; panels map 1:1 to the flow stages.
`AuthoringPanel` loads Embedding API v3 and renders `<tableau-authoring-viz>` with the
optional JWT.

## 10. Errors (`src/utils/errors.ts`)

`AppError(code, message, { details?, hint? })`; `sanitizeError()` maps code → HTTP
status and deep-redacts details → `SanitizedError` safe for the client. Codes include
`VALIDATION`, `AUTH_REQUIRED`, `AUTH_FAILED`, `NOT_FOUND`, `PERMISSION_DENIED`,
`DATASOURCE_LOCKED`, `APPROVAL_REQUIRED`, `TABLEAU_API`, `INTERNAL`.
