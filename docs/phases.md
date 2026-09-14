# Build Plan (Phases) — TableauPilot AI

> Living document. Update the status + "done" criteria whenever a phase changes. Last
> updated: 2026-09-13.

Status legend: ✅ done · 🚧 in progress · ⬜ not started.

---

## Phase 0 — Scaffold ✅
**Produces:** `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
`playwright.config.ts`, `eslint.config.js`, `.gitignore`, `.env.example`, git init.
**Done when:** `npm install` clean; `tsc`/lint/build run; `.env` is git-ignored.

## Phase 1 — Core infrastructure ✅
**Produces:** `src/config/env.ts`, `src/utils/{redaction,logger,errors}.ts`,
`src/llm/index.ts`.
**Done when:** typed config + redacted summary + boot validation; redacting logger;
`AppError`/`sanitizeError`; LLM model resolves for Anthropic gateway **and** OpenRouter.

## Phase 2 — Vault (credentials & sessions) ✅
**Produces:** `src/vault/{crypto,types,store,session,vault}.ts`.
**Done when:** register/unlock with 6-digit PIN; AES-256-GCM at rest; lockout;
save + PIN-gated update; `resetTableauState` on update; session sweeper.

## Phase 3 — Tableau connectivity ✅
**Produces:** `src/tableau/{tableauClient,auth,discovery,datasources,permissions}.ts`
+ `types.ts`.
**Done when:** PAT sign-in (URL-normalized); discovery (pagination); Metadata API query
with `unavailableReason`; advisory permission checks; subcode-aware error extraction.

## Phase 4 — Schemas + planning ✅
**Produces:** `src/schemas/*`, `src/agents/{tableauPilotAgent,dashboardPlannerAgent}.ts`,
`src/planning/index.ts`, `src/validation/{fieldValidation,guards}.ts`.
**Done when:** NL → Zod-validated `DashboardPlan`; robust JSON extraction fallback; all
plan fields validated vs live metadata; stable plan hashing + guards.

## Phase 5 — Mastra foundation ✅
**Produces:** `src/mastra/*`, `src/memory/index.ts`, `src/observability/index.ts`,
`src/tools/*`, `src/processors/*`.
**Done when:** agent + tools + memory + redacting observability wired; secret-protection
processor; `mastra dev` (Studio) works against the same brain.

## Phase 6 — Authoring generation ✅ (evolving)
**Produces:** `src/tableau/authoring/{twbGenerator,twbxPackager,index}.ts`.
**Done when:** plan → well-formed `.twb`; published-datasource `<repository-location>` +
`sqlproxy` connection; unique worksheet/dashboard window names + `<window
class='worksheet'>` per sheet; `.twbx` packaging (`fflate`).
**Note:** binding correctness is still being hardened (see [memory.md](./memory.md)).

## Phase 7 — Workflows ✅
**Produces:** `src/workflows/{dashboardCreationWorkflow,phases,index}.ts`.
**Done when:** phase workflows + orchestrating workflow with suspend/resume approval gate.

## Phase 8 — Publish + verify ✅ (unblocking)
**Produces:** `src/tableau/{publishing,verification}.ts`, `src/execution/index.ts`.
**Done when:** multipart REST publish to the approved project
(`skipConnectionCheck=true`); REST verification resolves the real Tableau URL and checks
project match.
**Open:** live publish currently blocked by a Tableau-side load/permission error chain
(400 binding → 403 `[500000]` internal). Tracked in [memory.md](./memory.md).

## Phase 9 — Backend BFF ✅
**Produces:** `src/server/{app,index}.ts`.
**Done when:** all `/api/*` routes (vault/tableau/dashboard/embed); CORS; sanitized error
boundary; `requireSession`; prod SPA serving.

## Phase 10 — Frontend UX ✅
**Produces:** `app/*` (`App.tsx`, `api.ts`, panels, `styles.css`, `types.ts`).
**Done when:** 4-step flow renders from context snapshot; connection/credentials/setup/
plan/authoring panels; only session id stored client-side; real Embedding API v3 embed.

## Phase 11 — Embed ✅
**Produces:** `app/components/AuthoringPanel.tsx`, `getEmbedInfo` + `/api/embed/info`.
**Done when:** real Web Authoring viz renders with optional short-lived Connected App JWT;
publish events captured.

## Phase 12 — Docs ✅
**Produces:** `README.md` + `docs/*` (this set + capability/limitation/security/auth docs).
**Done when:** prd/architecture/design/rules/phases/memory exist and match the code.

## Phase 13 — Security sweep ✅
**Done when:** no secret leaks in logs/errors/LLM I/O; redaction + processor verified.

## Phase 14 — Testing ✅
**Produces:** `tests/unit/*`, `tests/integration/*`, `tests/e2e/*`, fixtures.
**Done when:** unit + integration (Vitest) and non-destructive E2E (Playwright) pass;
`tsc`/lint/build clean. Current: **210 unit/integration passing**.

## Phase 15 — Salesforce connector: extract datasource builder ✅
**Produces:** `src/salesforce/{client,oauth,oauthStore}.ts`,
`src/tableau/authoring/tdsGenerator.ts` (Salesforce `.tds`),
`src/tableau/publishing/{hyperPackager,datasource}.ts`, `scripts/hyper/build_tdsx.py`,
`TableauService.buildAndPublishSalesforceDatasource`, `/api/connectors/salesforce/*`
routes, and the `SalesforceBuild` wizard in `app/components/SetupPanel.tsx`.
**Done when:** connect (username/password or OAuth) → model one/many objects
(relationship or physical-join) → generate `.tds` + local `.hyper`/`.tdsx` (Python Hyper
sidecar) → publish → embed saved Salesforce credential → trigger extract refresh. Single-
and multi-object builds work; **210 tests passing**; `tsc`/lint clean.
**Note:** the generated `.tds` must carry the object-model `<document-format-change-manifest>`
or Tableau loads the extract in legacy mode and shows one "Migrated Data" table. Added
2026-09-14 and **user-verified**: multi-object relationship builds now render the correct
related tables. See the 2026-09-14 [memory.md](./memory.md) entry.

## Phase 16 — Excel connector: extract-only datasource builder ✅
**Produces:** `src/excel/excelClient.ts` (`exceljs` parse → identifier-safe typed sheets),
`src/tableau/authoring/excelTdsGenerator.ts` (single / relationships / physical-join `.tds`
with an `excel-direct` connection, reusing the exported `tdsGenerator.ts` helpers),
`TableauService.{excelStoreUpload,excelBuildAndPublishDatasource}`,
`/api/connectors/excel/{upload,publish}` routes, the shared
`app/components/DataModelBuilder.tsx`, and `app/components/ExcelBuild.tsx` + a connector
dropdown in `SetupPanel`.
**Done when:** upload `.xlsx` → list sheets as "objects" → model one/many sheets
(relationship or physical-join, identical UI to Salesforce) → generate `.tds` + local
`.hyper`/`.tdsx` → publish **extract-only** (no embedded credential, no refresh) → lock +
converge on the normal dashboard flow. Single- and multi-sheet builds work; **210 tests
passing**; `tsc`/lint clean. **No Salesforce datasource logic changed** (only additive
`export`s in `tdsGenerator.ts` and a shared-component extraction in `SetupPanel`).

---

## Active workstream

- 🚧 **Harden published-datasource binding / publishing** so a live end-to-end publish
  verifies successfully. Next candidate if `skipConnectionCheck` isn't enough: download
  the real published-datasource connection XML and embed it. See [memory.md](./memory.md).
- 🔎 **Salesforce multi-object refresh behavior** — confirm whether a server-side refresh
  preserves all tables for relationship/join datasources, or gate refresh to single-object.
