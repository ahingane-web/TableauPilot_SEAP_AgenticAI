# Design — TableauPilot AI

> Living document. Update this whenever module interfaces, schemas, algorithms, or
> code-level decisions change. Last updated: 2026-09-29.

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
- **Salesforce connector** (in `common.ts`): `SalesforceCredentialsSchema`,
  `SalesforceObjectNameSchema`/`SalesforceFieldNameSchema` (identifier grammar),
  `SalesforceCardinalitySchema` (`one-to-one|one-to-many|many-to-one|many-to-many`,
  default `many-to-many`), `SalesforceJoinTypeSchema` (`inner|left|right|full`, default
  `left`), `SalesforceBuildModeSchema` (`relationship|join`, default `relationship`),
  `SalesforceRelationshipSchema` (leftObject/leftField/rightObject/rightField +
  cardinality + joinType), and `SalesforceBuildSchema` (credentials, tables[min 1],
  relationships[], mode, projectId, datasourceName, overwrite?, serverOauthCustom?). A
  `.superRefine` enforces multi-object connectivity: relationships must reference known
  tables and connect **every** table into one graph (union-find `isConnected`).
- **Excel connector** (in `common.ts`): `ExcelIdentifierSchema` (identifier-safe sheet/
  field id) and `ExcelBuildSchema` (sheets[min 1], relationships[] reusing
  `SalesforceRelationshipSchema`, mode, projectId, datasourceName, overwrite?) with the
  same union-find connectivity `.superRefine` as Salesforce (only the noun differs). No
  credentials (extract-only).

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

## 5b. Salesforce connector — extract datasource builder

A second entry point that connects to **Salesforce**, models one or more objects, and
publishes an **extract-backed** Tableau datasource (the LLM/plan flow is not involved).

**Salesforce client (`src/salesforce/client.ts`)** — `login()` (SOAP username/password +
optional security token), `resolveLatestApiVersion()` (queries unversioned
`/services/data/` after login and picks the highest version the org serves — avoids 404s
when the pinned `SALESFORCE_API_VERSION` hasn't rolled out), `listObjects()`,
`describeObject()` (field name/label/type), `queryRecords()` (SOQL, per-object row cap).

**Salesforce OAuth (`src/salesforce/{oauth,oauthStore}.ts`)** — interactive browser
sign-in: `generatePkce`/`generateState`, `buildAuthorizeUrl`, `exchangeCodeForToken`,
`fetchUserInfo`, `sessionFromToken`; `oauthStore` holds pending PKCE state (swept).

**TDS generation (`src/tableau/authoring/tdsGenerator.ts`)**:
- **All generators emit a `<document-format-change-manifest>` as the first child of
  `<datasource>`** (`documentFormatChangeManifestXml()`): `ObjectModelEncapsulateLegacy`,
  `ObjectModelExtractV2`, `ObjectModelTableType`, `SchemaViewerObjectModel`,
  `VConnDownstreamExtractsWithWarnings`, plus `ObjectModelRelationshipPerfOptions` for the
  relationships model. This is REQUIRED: without it Tableau loads an extract-backed datasource
  in legacy mode and collapses the object-graph into one "Migrated Data" table. Element order
  mirrors the references: manifest → `<connection>` → `<aliases enabled='yes'/>` → `<column>`s
  → `<extract>` → `<object-graph>`.
- `generateSalesforceTds()` — single-object extract `.tds`.
- `generateSalesforceRelationshipsTds()` — multi-object **relationships** model: a
  connection-level `<relation type='collection'>` of the objects, an `<object-graph>`
  with one `<object>` per table (live + `extract` context relations) and one
  `<relationship>` per edge; cardinality maps to `unique-key`/`is-db-set-unique-key`
  end-point flags (many-to-one → right unique, one-to-many → left, one-to-one → both,
  many-to-many → neither).
- `generateSalesforcePhysicalJoinTds()` — multi-object **physical join**: a left-deep
  `<relation type='join' join='left|right|inner|full'>` tree with `<clause type='join'>`
  ON-conditions (mirrored for the extract-side hyper tables). No object-graph.
- Multi-object metadata uses **qualified `[Object.Field]` local-names** (remote-name stays
  the raw API name) to avoid duplicate-field-name collisions across objects.
- Type maps: `salesforceToTwbDataType`, `salesforceToHyperType`.

**Extract packaging (`src/tableau/publishing/hyperPackager.ts`)** — `buildExtractTdsx()`
writes each object's schema + rows to temp files and shells out to the Python Hyper
sidecar (`scripts/hyper/build_tdsx.py`, interpreter `HYPER_PYTHON`/`.venv-hyper`) to
materialize a single `.hyper` (one `Extract."<Object>"` table per object) zipped with the
`.tds` into a `.tdsx`. No secrets/rows on argv (temp-file paths only). See
[python-dependency-decision.md](./python-dependency-decision.md).

**Post-publish helpers (`src/tableau/publishing/datasource.ts`)** —
`listDatasourceConnections()`, `embedDatasourceConnectionCredential()` (PUT
Update-Connection with `embedPassword='true'` + username → saved-credential match),
`refreshDatasourceNow()` (POST `.../refresh` → returns `{ jobId }`).

**Façade (`src/tableau/index.ts`)** — `TableauService` methods: `listConnectors`,
`salesforceListTables`/`salesforceListedTables`, `salesforceOauthStart`/
`completeSalesforceOauth`, `salesforceDescribeObject`, and
`buildAndPublishSalesforceDatasource(session, input)`. The latter: describe → SOQL query
(per-object cap) → generate `.tds` (single vs relationships vs join by `mode`) → build
`.tdsx` → publish → **embed saved credential** on the connection(s) → **trigger extract
refresh** (best-effort; see the caveat in [memory.md](./memory.md) about multi-object
server-side rebuilds). Transient Salesforce state lives on `session.connectors.salesforce`
and is cleared after publish; Salesforce credentials are never embedded.

## 5c. Excel connector — extract-only datasource builder

A third "Build datasource" entry point that uploads an **Excel** workbook, lists its
**sheets as "objects"**, and reuses the SAME modeling + extract + publish pipeline to
publish an **extract-only** datasource (no live credential, no refresh). No Salesforce
logic is touched — `tdsGenerator.ts` only gains additive `export`s, and the modeling UI is
extracted into a shared component.

**Workbook parsing (`src/excel/excelClient.ts`)** — `parseWorkbook(buffer, {maxRows})`
(via `exceljs`) → `{ sheets: ExcelSheet[] }`, where each `ExcelSheet` = `{ id, caption,
columns: {name,label,type}[], rows }`. Sheet/column names are sanitized to
identifier-safe, unique ids (`[A-Za-z][A-Za-z0-9_]*`; originals kept as `caption`/`label`)
so they survive the Salesforce-grade `.tds`/`.hyper` pipeline (real Excel already forbids
`: / [ ] * ? \` in sheet names). Per-column type inference samples cells (number→
integer/real, `Date`→date/datetime, boolean→boolean, else string); rows are coerced
(dates→ISO `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM:SS`) and capped at `hyper.maxRows`.

**TDS generation (`src/tableau/authoring/excelTdsGenerator.ts`)** — `generateExcelTds`
(single sheet), `generateExcelRelationshipsTds`, `generateExcelPhysicalJoinTds`, plus
`excelToHyperType`. Structurally identical to the Salesforce generators except: the
named-connection is `class='excel-direct'` with the uploaded `filename`, and physical
relations reference the sheet range `table='[<sheet>$]'`. It **reuses** the exported
connection-agnostic helpers from `tdsGenerator.ts` (`documentFormatChangeManifestXml`,
`colsMap*Xml`, `metadataRecords*Xml`, `columnsMultiXml`, `extractElement*Xml`,
`columnElement`, `salesforceObjectId`) by adapting each Excel column to a
`SalesforceColumnSpec` via a synthetic type token — so the extract, cols map,
metadata-records, columns, and object-graph output are the same as Salesforce (the sheet id
plays the role of the object). Reconciled against `reference/sample ds Excel Connector.tds`.

**Façade (`src/tableau/index.ts`)** — `excelStoreUpload(session, buffer, filename)` parses
+ stashes transient `session.connectors.excel = { uploadId, filename, sheets }` and returns
non-secret sheet identity; `excelBuildAndPublishDatasource(session, input)` selects the
sheets, validates the relationship join-fields, builds the `.tds` (single/relationships/
join by `mode`) + `.hyper`/`.tdsx` via the SAME `buildExtractTdsx`, calls `publishDatasource`
with **no `connectionCredentials`** and **skips** credential embed + refresh (extract-only),
locks the datasource, and writes `session.flow.connectorMetadata` via `excelSheetsToMetadata`
(qualified `SheetId.Field` for multi-sheet). The transient upload is cleared after publish.

## 5d. Google BigQuery connector — live OR extract datasource builder

A third "Build datasource" entry point that signs in with **Google (browser OAuth + PKCE)**,
lists **Billing Project > Project > Dataset > tables**, and reuses the SAME shared modeling UI
(`DataModelBuilder`) + publish/lock pipeline. A **Live/Extract** selector chooses the shape.
No Salesforce/Excel logic is touched (all additive).

**OAuth (`src/bigquery/oauth.ts` + `oauthStore.ts`)** — Google Authorization-Code + PKCE:
`buildAuthorizeUrl` (`accounts.google.com/o/oauth2/v2/auth`, scopes `openid email` +
`bigquery` + `cloudplatformprojects.readonly` — matching Tableau Desktop's own BigQuery
connector; `access_type=offline`, `prompt=consent`),
`exchangeCodeForToken`/`refreshAccessToken` (`oauth2.googleapis.com/token`), `fetchUserEmail`
(userinfo → connection username). A single-use `state`→`PendingBigQueryOauth` map (10-min TTL,
swept by `startSessionSweeper`) routes the header-less callback to the originating session. The
OAuth **client id/secret are dynamic**: `bigQueryOauthStart` resolves them per-request (UI) →
vault (`VaultService.getBigQueryOAuthClient`) → `GOOGLE_OAUTH_*`. `/api/connectors` reports
`oauthConfigured`; when the server has no env client, `BigQueryBuild` shows an in-UI how-to +
Client ID/secret inputs and can persist them **encrypted in the vault** (`saveBigQueryOAuthClient`
→ `TableauCredentials.bigQueryOAuth`, secret preserved when a blank submit reuses the same id) via
`POST /api/connectors/bigquery/oauth/client`, prefilled on return by the GET. Only this reusable
client is vaulted; the access/refresh token stays transient on the session and the email comes
from `userinfo` (never asked).

**REST client (`src/bigquery/client.ts`, pure `fetch`)** — `listProjects` (Cloud Resource
Manager `projects.list`), `listDatasets`/`listTables`/`describeTable`/`queryRows` (BigQuery v2
`datasets.list`/`tables.list`/`tables.get`/`jobs.query`+pagination). `describeTable` returns
scalar columns (real name + identifier-safe `safeName` + type + nullability), skipping
nested/repeated fields. `queryRows` builds a backtick-quoted `google-sql` SELECT against the
billing project and coerces values to the Hyper sidecar formats. `bigQueryToSalesforceToken`/
`bigQueryToHyperType` map BQ types. Only this module talks to Google; never to Tableau.

**TDS generation (`src/tableau/authoring/bigqueryTdsGenerator.ts`)** — `generateBigQueryTds`
(single), `generateBigQueryRelationshipsTds`, `generateBigQueryPhysicalJoinTds`, each taking
`materialization: 'live' | 'extract'`. Emits a `class='bigquery'` OAuth named-connection
(`CATALOG`=data project, `EXECCATALOG`=billing project, `project`=display name, `schema`=dataset,
`server-oauth=''`, `username`=email) and `[project.dataset].[table]` relations, reconciled 1:1
with `reference/BigQueryDataset{Live,Extract}.tds`. Because BQ column names may contain
spaces/hyphens, it writes its OWN `<cols>`/`<metadata-records>`/`<column>`/`<object-graph>`,
keeping the REAL name as `remote-name`/`remote-alias` and a globally-unique `local-name`
(duplicates become `Name (Table)`). **Live** omits `<extract>` and the `ObjectModelExtractV2`
manifest flag and maps only `context=''`; **Extract** adds the `class='hyper'` extract over
`Extract."<objectId>"` tables (object-id = `<SafeTable>_<md5>`) + a `context='extract'`
object-graph property. `bigQueryFieldIdentities` exposes the disambiguated identities so the
façade's metadata matches the published datasource exactly.

**Façade (`src/tableau/index.ts`)** — `bigQueryOauthStart`/`completeBigQueryOauth`/
`bigQueryConnected`, `bigQueryListProjects`/`bigQueryListDatasets`/`bigQueryListTables`/
`bigQueryDescribeTable`, and `buildAndPublishBigQueryDatasource(session, input)`: describe each
table → (extract only) query rows → generate the `.tds` (single/relationships/join × live/extract)
→ publish a `.tdsx` (extract, via `buildExtractTdsx`) or a bare `.tds` (live) with an embedded
Google OAuth credential → best-effort embed on the connection(s) → **extract-only**
`refreshDatasourceNow` → lock + `bigQueryTablesToMetadata`. `bigQueryAuth` refreshes the token
near expiry. Transient state lives on `session.connectors.bigquery` (email + access/refresh token
+ OAuth client) and is cleared after publish.

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
| GET | `/api/connectors` | list source connectors (Salesforce, Excel, Google BigQuery) |
| POST | `/api/connectors/salesforce/connect` | username/password login → list objects |
| POST | `/api/connectors/salesforce/oauth/start` | begin browser OAuth (PKCE) |
| GET | `/api/connectors/salesforce/oauth/callback` | OAuth redirect handler |
| GET | `/api/connectors/salesforce/tables` | listed objects for the session |
| POST | `/api/connectors/salesforce/describe` | describe an object's fields |
| POST | `/api/connectors/salesforce/publish` | build + publish extract datasource |
| POST | `/api/connectors/excel/upload` | upload `.xlsx`/`.xlsm` (multipart) → list sheets + columns |
| POST | `/api/connectors/excel/publish` | build + publish an **extract-only** Excel datasource |
| POST | `/api/connectors/bigquery/oauth/start` | begin Google browser OAuth (PKCE) |
| GET | `/api/connectors/bigquery/oauth/callback` | Google OAuth redirect handler |
| GET | `/api/connectors/bigquery/oauth/client` | read vault-saved OAuth client (non-secret) + env-configured flag |
| POST | `/api/connectors/bigquery/oauth/client` | save/clear the OAuth client id/secret in the user's vault |
| GET | `/api/connectors/bigquery/status` | whether a BigQuery OAuth session is active (+ email) |
| GET | `/api/connectors/bigquery/projects` | list the account's GCP projects |
| GET | `/api/connectors/bigquery/datasets?projectId=` | list datasets in a project |
| GET | `/api/connectors/bigquery/tables?projectId=&datasetId=` | list tables in a dataset |
| POST | `/api/connectors/bigquery/describe` | describe a table's columns |
| POST | `/api/connectors/bigquery/publish` | build + publish a **live or extract** BigQuery datasource |

Client returns a sanitized error envelope `{ error: { code, message, hint?, details? } }`.

## 9. Frontend (`app/*`)

`api.ts` stores only the session id (localStorage) and injects `x-session-id`; `App.tsx`
renders the 4-step flow from the context snapshot; panels map 1:1 to the flow stages.
`AuthoringPanel` loads Embedding API v3 and renders `<tableau-authoring-viz>` with the
optional JWT. `SetupPanel` hosts the **Salesforce data-source builder** (`SalesforceBuild`)
— a 3-step wizard (Connect → Model → Publish) with a Relationship|Join segmented control,
a "combine multiple objects" toggle, and per-table relationship/join cards; it calls
`api.salesforcePublish({ tables, relationships, mode, ... })`. Styles for it live in
`app/styles.css` (`.sf*`, `.segmented`, `.switch`, `.tablecard`, `.joinrow`).

**Theme & UX (light "Tableau" look).** `app/styles.css` is a light theme driven entirely by
`:root` CSS variables (`--bg/--panel/--panel-2/--border/--text/--muted` neutrals + Tableau
`--accent/--accent-2/--ok/--warn/--danger` accents); components reference the variables, so
the palette is swappable without JSX changes. `common.tsx` exports a presentational
`Collapsible` (header + chevron + count badge, toggles children via local `useState`) used to
show/hide the **datasource fields** (`SetupPanel`, default collapsed) and the **sheets &
dashboards** hierarchy (`PlanPanel`, default open). `App.tsx` has a topbar **Hide/Show
dashboard** toggle (`showDashboard`) that drops the `.gutter` + `.right` pane so the workflow
pane expands full-width (splitter/drag only wired while shown). Two UI-only status banners
give post-modification feedback: `PlanPanel` shows a `.warnbox` **"Modifications done —
waiting for approval to build"** when the plan is edited/revised and not yet re-approved, and
`PublishedViewPanel` shows a transient `.success` **"Modification done and dashboard published
successfully"** after an in-place republish. These are presentational only — no `api.*` call,
approval-gating, or build/publish/modify logic changed.

## 10. Errors (`src/utils/errors.ts`)

`AppError(code, message, { details?, hint? })`; `sanitizeError()` maps code → HTTP
status and deep-redacts details → `SanitizedError` safe for the client. Codes include
`VALIDATION`, `AUTH_REQUIRED`, `AUTH_FAILED`, `NOT_FOUND`, `PERMISSION_DENIED`,
`DATASOURCE_LOCKED`, `APPROVAL_REQUIRED`, `TABLEAU_API`, `INTERNAL`.
