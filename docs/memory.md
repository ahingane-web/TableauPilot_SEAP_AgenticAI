# Memory — Living Progress Log

> Append-only-ish running log of environment facts, status, decisions, and fixes.
> Newest entries at the top of the change log. Last updated: 2026-09-14.

## Environment facts

- **OS:** macOS (darwin). **Runtime:** Node ≥ 20.9, TypeScript, ESM.
- **Dev servers:** `npm run dev` → API (Hono) on **:4000**, Vite SPA on **:5173**
  (falls back to :5174 if busy). Server runs `tsx watch` (auto-reload on save).
- **LLM:** provider `anthropic`, model `claude-opus-4-8`, via a configured
  Anthropic-compatible **gateway** (`ANTHROPIC_BASE_URL` + key/helper, CA cert set).
- **Tableau:** REST API `3.24`; test site content URL `ahingane-2010f153ff`; test user
  `Akash2121` (**Site Administrator Creator**); target project `Tableau_Agent_Folder`;
  locked datasource `Superstore_DS` (contentUrl also `Superstore_DS`).
- **Vault:** `DATA_PATH=./data` (git-ignored), `VAULT_PEPPER` set.

## Status by phase (summary)

- Phases 0–5, 7, 9–14: ✅ complete. See [phases.md](./phases.md).
- Phase 6 (authoring generation): ✅ but **binding hardening ongoing**.
- Phase 8 (publish+verify): 🚧 **blocked on a live Tableau publish error** (details
  below). Code path is complete; Tableau Cloud rejects the generated workbook.
- Phase 15 (Salesforce connector datasource builder): ✅ build + publish work; see the
  newest entry below.
- Tests: **193 unit/integration passing**; `tsc`/lint/build clean.

## Fix: relationship datasource showed "Migrated Data" (newest first)

- **2026-09-14 — RESOLVED & user-verified.** After adding the object-model manifest (below), a
  multi-object **relationship** build now opens in Tableau as the correct related tables (noodle)
  — the user confirmed it "works perfectly fine with relationship build." The manifest was the
  real fix; the older 2026-09-13 refresh-collapse caveat has NOT recurred in practice, so the
  post-publish refresh is left running for all builds (no logic change).
- **2026-09-14 — Missing object-model manifest made extracts load as legacy.** A multi-object
  **relationship** Salesforce datasource opened in Tableau as a single **"Migrated Data"**
  table instead of related tables. Root cause: the generated `.tds`
  ([src/tableau/authoring/tdsGenerator.ts](../src/tableau/authoring/tdsGenerator.ts)) omitted
  the `<document-format-change-manifest>` that BOTH working references carry
  (`reference/sample_datasource_DataModelling.tds` and the embedded `.tds` in
  `reference/Salesforce_Account_DS.tdsx`). Without `<ObjectModelExtractV2 />` +
  `<ObjectModelEncapsulateLegacy />` (+ `ObjectModelTableType`, `SchemaViewerObjectModel`, and
  — relationships only — `ObjectModelRelationshipPerfOptions`), Tableau loads the extract in
  **legacy** mode and flattens the `<object-graph>` into one "Migrated Data" table. The rest of
  the path was already correct: schema defaults `mode` to `relationship`, the route/orchestrator
  pass it through, and the Python sidecar builds a genuine multi-table `Extract."<Object>"` hyper.
  - **Fix:** added a `documentFormatChangeManifestXml(relationshipPerf)` helper emitted as the
    FIRST child of `<datasource>` in all three generators (`generateSalesforceTds`,
    `generateSalesforceRelationshipsTds` [perf flag on], `generateSalesforcePhysicalJoinTds`).
    Also aligned element order to the references: `<aliases enabled='yes' />` now sits right
    after `</connection>` (before `<column>`s/`<extract>`/`<object-graph>`).
  - **Not the cause (left as-is):** `server-oauth='server-custom'` (matches the published
    reference) and the minimal `<extract>`/`<connection>` attribute set.
  - **Tests:** extended [tests/unit/tdsGenerator.test.ts](../tests/unit/tdsGenerator.test.ts)
    with manifest-present + manifest-precedes-connection + aliases-before-extract guards for all
    three generators (+3 cases).

## Feature: Light "Tableau" UI revamp (newest first)

Look-&-feel + UX pass over the SPA (`app/**`) with **no logic changes** — all `api.*`
calls, state transitions, approval gating, and build/publish/modify flows are byte-for-byte
unchanged. This was a CSS + presentational-component pass only.

- **2026-09-14 — Light theme + UX affordances.**
  - **Theme (`app/styles.css`):** replaced the dark palette with a light Tableau theme,
    keeping the SAME CSS variable and class names so JSX needed no churn. New surfaces
    (`--bg:#eef1f6`, `--panel:#fff`, `--panel-2:#f4f6fa`, `--border:#dbe1ea`,
    `--text:#1b2733`, `--muted:#5b6b7f`) and Tableau accents (`--accent:#1f77b4`,
    `--accent-2:#f28e2b`, `--ok:#2e9e5b`, `--warn:#d9822b`, `--danger:#e15759`). Added soft
    panel shadows, blue focus rings, hover states, light tints for `.success/.warnbox/.error`
    and the pills/steps/badges, and a new `.collapse` block for the show/hide sections.
  - **Reusable `Collapsible` (`app/components/common.tsx`):** presentational header (accent
    dot, title, optional count badge, chevron, Show/Hide) that toggles its children via local
    `useState`.
  - **Datasource fields (`SetupPanel.tsx`):** the Dimensions/Measures/Dates `FieldPills` are
    wrapped in `Collapsible` ("Datasource fields", field-count badge, **default collapsed**).
    The inline `#eef6ff` notice now uses the themed `.sf-note` class. `FieldPills` and
    metadata loading untouched.
  - **Sheets & dashboards (`PlanPanel.tsx`):** `BoardHierarchy` wrapped in `Collapsible`
    ("Sheets & dashboards", default open); hardcoded dark inline borders (`#2a2a2a`, `#333`)
    → `var(--border)`. Color-picker defaults left as-is (they are dashboard data). Added a
    UI-only `edited` flag → `.warnbox` banner **"Modifications done — waiting for approval to
    build."** shown when a plan is revised/edited and not yet re-approved (cleared on
    generate/approve).
  - **Post-publish modify (`PublishedViewPanel.tsx`):** UI-only `modifySuccess` flag → a
    transient (auto-dismiss 4s) `.success` banner **"Modification done and dashboard published
    successfully."** after `modify()` republishes + reloads. Republish/reload logic unchanged.
  - **Dashboard pane toggle (`App.tsx`):** new `showDashboard` state + topbar "Hide/Show
    dashboard" button. When hidden, the `.gutter` + `.right` pane are not rendered and the
    `.left` workflow pane expands full width; drag/splitter is only wired when shown.
  - **Verify:** `tsc`, ESLint, and the full **190** tests pass (the 2 Hyper-sidecar tests only
    fail inside the network sandbox because the Hyper binary can't spawn there; they pass
    normally).

## Feature: Salesforce connector — extract datasource builder (newest first)

A second entry point alongside dashboard authoring: connect to **Salesforce**, model one
or more objects, and publish an **extract-backed** Tableau datasource. Lives under
`src/salesforce/*` (SOAP login, REST describe/query, OAuth PKCE) + `src/tableau/authoring/
tdsGenerator.ts` (`.tds`) + `src/tableau/publishing/hyperPackager.ts` (`.hyper`/`.tdsx`
via the Python sidecar) + `TableauService.buildAndPublishSalesforceDatasource`. UI is the
redesigned **`SetupPanel` → SalesforceBuild** (3-step wizard). Routes are under
`/api/connectors/salesforce/*`.

- **2026-09-13 — Post-publish credential embed + extract refresh step.** After publishing,
  the orchestration now (1) lists the datasource connection(s) and **embeds the saved
  Salesforce OAuth credential** (matched by username, `embedPassword='true'`) via
  `embedDatasourceConnectionCredential`, then (2) triggers a server-side **extract refresh**
  (`refreshDatasourceNow` → `POST /sites/{site}/datasources/{id}/refresh`) so Cloud records
  a refresh and re-pulls data with the embedded credential. Both are **best-effort** (a
  failure never fails the publish; the bundled `.hyper` already holds fresh data).
  New client helpers in `publishing/datasource.ts`: `listDatasourceConnections`,
  `embedDatasourceConnectionCredential`, `refreshDatasourceNow` + `TableauClient.putJson`.
  - **Caveat (documented in code):** for a **multi-object** datasource (relationships/
    joins), a server-side refresh makes Tableau REBUILD the extract with its own engine,
    which may collapse it to the first table ("migrating data… only 1st table"). The
    bundled extract at publish time always contains all tables. Earlier this refresh was
    gated to single-object only; per user request it now runs for all — flip the guard in
    `buildAndPublishSalesforceDatasource` back to `if (!isMulti)` if the collapse recurs.
- **2026-09-13 — Relationship vs Join modes.** `SalesforceBuildSchema.mode`
  (`'relationship' | 'join'`, default `relationship`). Relationship mode →
  `generateSalesforceRelationshipsTds` (Tableau object-graph: `<objects>` +
  `<relationships>`, cardinality via `unique-key`/`is-db-set-unique-key` end-point flags).
  Join mode → `generateSalesforcePhysicalJoinTds` (left-deep `<relation type='join'
  join='left|right|inner|full'>` + `<clause type='join'>`). Per-relationship `cardinality`
  (default `many-to-many`) drives relationship mode; `joinType` (default `left`) drives
  join mode. Verified structurally against `reference/sample_datasource_DataModelling.tds`.
- **2026-09-13 — Redesigned SetupPanel UI.** Salesforce builder rebuilt as a 3-step wizard
  (Connect → Model → Publish) on the dark theme: header badge + step tracker, section
  cards (Model/Publish dimmed until connected), a toggle switch for "Combine multiple
  objects", a segmented control for Relationship|Join, and per-table cards with an inline
  `field = field` row. New classes in `app/styles.css` (`.sf*`, `.segmented`, `.switch`,
  `.tablecard`, `.joinrow`, `.checkline`, `.addbtn`).
- **Duplicate field name fix.** Multi-object `.tds` uses **qualified** `[Object.Field]`
  local-names (remote-name stays the raw API name) so common fields (`Id`, `Name`,
  `AccountId`) don't collide across objects (previously: extract-refresh
  `TableauException: Duplicate field name 'Id'`).
- **Salesforce REST API version auto-discovery.** After SOAP login,
  `resolveLatestApiVersion()` queries the unversioned `/services/data/` endpoint to pick
  the highest version the org actually serves (fixes `404 on /services/data/v59.0/...` on
  orgs where the pinned version hasn't rolled out yet).
- **Transient session model.** Salesforce creds + live session + listed tables are stored
  only in-memory on `session.connectors.salesforce` for describe/query/build, and cleared
  once publishing completes. Salesforce credentials are **never** embedded — the published
  datasource authenticates via the saved Salesforce credential on Tableau Cloud.

## Calculation-engineer subagent (ported from Version2, adapted)

Added a specialized subagent `calculationEngineerAgent` (`src/agents/calculationEngineerAgent.ts`)
that designs correct, simple Tableau calculated fields as validated structured specs
(LOD / table calcs / period-over-period / cohort / Top-N+Others / ranking / fiscal).

- **Live-datasource model** (not Version2's `twbxPath`): its read-only tools resolve the
  server-side session from `requestContext.sessionId` and read the LOCKED datasource's
  live metadata. Tools: `inspect_fields`, `validate_field`, `validate_calculation`
  (`src/tools/calcInspectionTools.ts`).
- **Delegate tool** `design_calculated_fields` (`src/tools/calculationTool.ts`) builds a
  metadata-grounded prompt, calls the subagent with structured output
  (`CalcDesignResultSchema` = { calculations, rationale, configNotes, clarificationNeeded }),
  and **self-corrects once** if any `[field]` reference is unknown (`validateCalcRefs` +
  `selfCorrectRefs`). Exposed to `tableauPilotAgent` via `agentTools.design_calculated_fields`.
- Registered in `src/mastra/index.ts` (`agents.calculationEngineerAgent`). Tested:
  `tests/unit/calculationTool.test.ts` (ref validation + one-shot self-correction).

## Authoring polish pass (newest first)

Implemented a batch of authoring/UX rules (ported patterns from the reference project
`Mastra Agent Tableau Version2`):

- **KPI-row purity:** `normalizeKpiRows()` in `twbGenerator.ts` splits any row that mixes a
  KPI card with a non-KPI chart into a KPI row (first) + chart row, renumbered densely.
  Planner is instructed to keep KPI cards in their own top row.
- **Real Top-N / Bottom-N:** `FilterSpec.topN` ({ n, byMeasure, measureAggregation,
  direction, nParameter }). `filters.ts` emits the ranked `<filter class='categorical'>`
  with nested `groupfilter function='end'` → `order` (`SUM([Measure])`, DESC/ASC) →
  `level-members`. The generator **always creates a "Top N" integer parameter** (range
  control) and references it as `count='[Parameters].[Parameter k]'`. The worksheet
  declares `<datasource name='Parameters' />` + a `datasource-dependencies` for it
  (`renderWorksheetParameterDeps`).
- **Legends in the Filters panel:** `renderWorksheet` returns the color/size/shape legends
  it exposes (with field decls); `twbGenerator` renders them as `type-v2='color|size|shape'`
  zones inside the right pinned panel and adds their fields to the dashboard deps.
- **Worksheet titles:** every non-KPI worksheet gets `<layout-options><title>` with a
  `bold='true' fontname='Tableau Bold' fontsize='12'` run. KPI titles stay hidden
  (`show-title='false'` on the dashboard zone).
- **Dashboard size Automatic/Fixed/Range:** `DashboardLayoutSpec.size` is now
  `automatic|fixed|range` (+ min/max bounds); `buildDashboardSizeXml()` emits the matching
  `<size sizing-mode=...>`. The app **always asks the user** to confirm a size before
  approval: `setDashboardSize()` service → `POST /api/dashboard/size` → `api.setSize` →
  `SizeChooser` in `PlanPanel` (approval is gated until a size is chosen).

Version2 subagents reviewed: only `tableauPilotAgent` (main copilot) and
`calculationEngineerAgent` (LOD/table-calc/ranking calc designer). The latter is a
candidate to port but is a scope-expanding addition (tool-using subagent + extra LLM call)
— deferred pending confirmation.

## Rule: context filters gated on Top-N (newest first)

In `generateTwb()` (`twbGenerator.ts`), context filtering is now driven purely by whether
the dashboard contains a **Top-N** filter (`operator === 'top_n'` on any dashboard- or
worksheet-level `FilterSpec`):

- `hasTopN` → **all other** slicer filters are emitted with `context='true'` so the Top-N
  ranks *within* the filtered subset (Tableau evaluates context first, then ranks).
- No Top-N → **no** context filters at all.
- The Top-N filter itself is never a context filter.
- Apply-to-all across sheets remains a shared `filter-group` (independent of context), so
  multi-target filters still tie together even when not in context.

Helper: `useContext(spec) = hasTopN && spec.operator !== 'top_n'`, applied to both the
dashboard-level and worksheet-local filter loops. Tests updated: the fixture (no Top-N)
now asserts `filter-group` **without** context; a new test adds a Top-N filter and asserts
the Region slicer becomes `context='true' filter-group='1'` while the Top-N stays
non-context. **73 tests passing**; `tsc`/lint clean.

## Feature: sheet-in-container dashboard layout

Rewrote `renderDashboard()` in `twbGenerator.ts` to emit Tableau's real nested
flow-container structure instead of flat absolute leaf zones. Verified against the
sample-workbook dashboards (`dash_sample_dashboard_{fixed,automatic}_size.xml`) and
Version2's `dashboardCompiler.ts` (`partitionV/partitionH`, `dims`, `leafStyle`/
`containerStyle`).

Structure (top→down):
- `<zone type-v2='layout-basic'>` root (id 1, margin=8) → single vertical `layout-flow`.
- **Title band**: `fixed-size='50' is-fixed='true' layout-strategy-id='distribute-evenly'`
  vertical flow holding a `type-v2='text'` zone (Tableau Bold 16).
- **Content**: horizontal `layout-flow` → left column + optional right panel.
- **Left**: vertical `layout-flow` of ROW containers (`param='horz'`). Each **cell** is a
  `param='horz' layout-flow` container that **wraps one sheet leaf** (`<zone name='...'>`);
  the container carries the white `#ffffff` card background, the leaf only border/margin.
  This "sheet-in-container" nesting is what resizes cleanly and looks author-made.
- **KPI rows** (all cells are `chartType==='kpi'`) are pinned `fixed-size='130' is-fixed`
  and the sheet leaves get `show-title='false'`.
- **Right Filters panel**: `fixed-size='200' is-fixed='true'` vertical flow with a
  Semibold-12 "Filters" heading, one `type-v2='filter'`/`paramctrl` zone per control, and a
  trailing `type-v2='empty'` spacer; white card background.
- Dashboard `<style>` now sets `table` background `#e6e6e6`.

Geometry via `partitionV`/`partitionH` in the 0–100000 space; Tableau recomputes flow
geometry on open so only the tiling + `param`/`fixed-size`/`is-fixed` matter. Dashboard
`<datasources>` + `<datasource-dependencies>` wiring for filter controls is unchanged.
Preserves the working sqlproxy datasource binding. Tests: **72 passing** (added a
sheet-in-container nesting assertion); updated title/heading run + leaf-zone assertions
(leaf zones are no longer self-closing). `tsc`/lint clean.

## Feature: interactive filter + parameter panel

Added interactive controls to the generated dashboards (the "best dashboard" panel):

- **`filters.ts`** — `resolveFilter()` compiles a `FilterSpec` into worksheet `<filter>` XML:
  categorical member/union (specific values), categorical "show all" enumerate (interactive
  default when no values), and quantitative `included-values='in-range'` (measure ranges). It
  also exposes the control `ref` + `<column>`/`<column-instance>` decls for the dashboard.
- **`parameters.ts`** — `resolveParameters()` + `renderParametersDatasource()` emit the inline
  `<datasource name='Parameters'>` pseudo-datasource (`param-domain-type` any/list/range, current
  value calc, members/range) and expose each parameter's `[Parameters].[Parameter N]` ref +
  control mode (dropdown/slider/type_in).
- **`worksheet.ts`** — `renderWorksheet` now accepts `filters: AppliedFilter[]`, declares each
  filtered field's column-instance, and emits `<filter>` + `<slices>` inside the view.
  Apply-to-all uses `context='true'` + a shared `filter-group` across every target worksheet.
- **`twbGenerator.ts`** — `generateTwb` resolves `plan.filters` (→ targets, filter-groups, panel
  controls) and worksheet-local `ws.filters`, injects the `Parameters` datasource into
  `<datasources>`, and `renderDashboard` now reserves an 18% right-hand panel (heading + quick
  filter `type-v2='filter'` controls + `type-v2='paramctrl'` controls) with the dashboard's own
  `<datasources>` + `<datasource-dependencies>` so the controls bind. No panel/deps when there
  are no filters/params (grid stays full-width — backward compatible).

Planner prompt + `dashboardPlannerAgent` now propose 2-4 interactive filters + parameters.
`tsc`/lint clean; 71 tests pass. Sqlproxy binding + publish flow unchanged.

## Feature: chart & dashboard building — ported from the Tableau-Desktop agent (newest first)

Ported the dashboard/chart-building intelligence from the sibling project
`/Users/ahingane/Desktop/Mastra Agent Tableau Version2` onto our working direct-to-Cloud
`sqlproxy` publish path (basic structure unchanged). New authoring modules under
`src/tableau/authoring/`:

- **`pill.ts`** — `resolvePill()`: one source of truth for `[dsName].[deriv:Field:typekey]`
  column-instances. Handles aggregation codes (sum/avg/cnt/ctd/min/max/med), already-aggregated
  calcs (`usr`/`User`), discrete vs continuous, and date derivations (discrete `yr/mn/…` vs
  continuous trunc `tyr/tmn/…`). `isAggregateFormula()` classifies calc measures.
- **`numberFormat.ts`** — `buildNumberFormat()`: currency/percentage/number/scientific with
  K/M scale + decimals (e.g. `c"$"#,##0,,.0M;-"$"#,##0,,.0M`). `looksLikeCurrency()` heuristic.
- **`chartRegistry.ts`** — `CHART_REGISTRY`: mark class + placement `strategy` per chart type.
- **`worksheet.ts`** — chart-type-aware `renderWorksheet()`: shelf placement + encodings per
  strategy (bar/line/area/stacked/side-by-side/scatter/pie/donut/text/highlight/heatmap/treemap/
  bubble/map/gantt/histogram), value labels, measure number formats (cell `text-format`),
  **KPI cards** (customized-label big value w/ Æ+&#10; line-break trick), **dual-axis** (two
  measures via `[:Measure Names]` across synced panes with `y-axis-name`), and **maps** (generated
  Lat/Long + geo detail). Multiple measures join with ` + `, dimensions with ` / `.
- **`xml.ts`** — shared `escapeXml` / `twbDataType` / `localName` (breaks the generator ↔ worksheet
  cycle; `escapeXml` re-exported from `twbGenerator.ts` for back-compat).

Schema (additive): `common.ts` ChartType enum extended (+horizontal_bar, stacked_bar,
side_by_side_bar, dual_line, bubble, bar_line_combo) plus `DateDerivation`/`NumberFormatKind`/
`NumberScale`; `MeasureRef` gains optional `numberFormat`/`decimalPlaces`/`scale`/`currencySymbol`/
`aggregated`. `renderDashboard` now emits a **title band** + proportional grid that fills the
0–100000 canvas (was fixed 20000px rows) + honors `layout.size` (automatic vs fixed).
`dashboardPlannerAgent` instructions + planning prompt now carry chart-selection, field-ordering,
formatting, and layout heuristics for "best" dashboards.

The sqlproxy datasource binding, publish flow, and window/viewpoint logic are UNCHANGED.
Verified: all 26 chart types compile; 66 tests pass; `tsc`/lint clean. _Pending live re-publish
to confirm the richer worksheets render in Tableau Cloud._

## Feature: user-chosen workbook name + overwrite prompt (newest first)

- **User can now name the workbook and decide overwrite on a name clash.**
  - `POST /api/dashboard/plan` accepts an optional `workbookName`; the planner uses it
    (falling back to the AI's `dashboardName`). `generateDashboardPlan` now also returns
    `nameConflict` — checked via `TableauService.listWorkbooks` (exact name, same target
    project, case-insensitive; check failures never block planning).
  - New `POST /api/dashboard/publishing` → `setPublishingOptions(session, { workbookName?,
    overwrite? })` updates `publishing` on the existing session plan **without re-running
    the LLM**, then clears approval (publishing is in the approval hash) so the user
    re-approves the final target.
  - Frontend (`app/components/PlanPanel.tsx`): a "Workbook name" input; on `nameConflict`
    a warn box offers **Overwrite existing** or **Rename & re-check**; Approve is blocked
    until the clash is resolved (overwrite chosen or renamed). Preview shows the
    on-name-clash decision. `app/api.ts` gains `setPublishing`; `app/types.ts` adds
    `nameConflict` + `publishing.overwrite`.
  - `hintForTableauError` now maps **403130** ("workbook already exists … overwrite=true
    required") to an actionable overwrite/rename hint (safety net if the pre-check misses).
  - Rationale: the approval hash covers `publishing`, so workbook name + overwrite must be
    finalized BEFORE approval — hence the decision happens at plan/preview time, not at
    execute time. **66 tests passing; tsc/lint clean.**

## Publish debugging — resolved error chain (newest first)

Live publishing has progressed through a chain of distinct Tableau errors, each fixed:

9. **View load failure — SOLVED via ground-truth sample (published-datasource ref).** The
   user added a sample `.twbx` that references a **published datasource** (server ref, not
   an embedded extract). Studying its XML overturned the earlier hypothesis:
   - A workbook that references a published datasource connects through Tableau's **DATA
     SERVER** via a `class='sqlproxy'` connection. There is **NO `<repository-location>`**
     anywhere in the file (grep = 0). The earlier repository-location + downloaded-`.tds`
     embed approach was wrong (a workbook uses a *sqlproxy proxy* connection, not the
     datasource's own source connection).
   - The datasource's internal `name` is **`sqlproxy.<hash>`** (not `federated.*`), and
     worksheets reference fields as `[sqlproxy.<hash>].[none:Category:nk]`.
   - The connection carries the pod's data-server host as `server`
     (`prod-in-a.online.tableau.com` — i.e. the hostname of the Tableau Cloud server URL),
     plus fixed attrs: `channel='https'`, `dbname='<datasource id>'`, `directory='/dataserver'`,
     `port='443'`, `local-dataserver=''`, `username=''`.
   - A `<relation type='collection'><relation name='sqlproxy' table='[sqlproxy]' type='table'/></relation>`
     and one `<metadata-record class='column'>` per field (`parent-name='[sqlproxy]'`,
     `remote-type` OLE DB codes: string 130, real 5, integer 20, date 7, datetime 135,
     boolean 11) describe the schema.
   **Fix (implemented):** rewrote `renderDatasource` in `twbGenerator.ts` to emit exactly
   this sqlproxy binding; `DS_NAME` → `sqlproxy.tableaupilot`; added `remoteTypeCode`,
   `metadataAggregation`, `renderMetadataRecords`; `GenerateTwbOptions.serverHost` replaces
   `siteContentUrl`/`publishedDatasource`. `publishPlan` derives `serverHost` from the
   session's Tableau server URL (`hostFromUrl`). **Removed** the abandoned REST-download
   feature (`src/tableau/datasources/download.ts` + `datasourceDownload.test.ts`) and item-8
   embed path. **61 tests passing; `tsc` clean.** _Pending live verification: republish and
   confirm the view loads._

8. **View load failure after successful publish** — _(superseded by #9)_ `TableauException: Errors occurred
   while trying to load the workbook ".../views/SalesAnalysisDashboard". The load was not
   able to complete successfully.` The workbook now PASSES `<publish check>` but fails at
   view/render time. Root cause: the published-datasource binding (sqlproxy/federated
   connection + `<relation>` + `<metadata-records>`) is **server-assigned and not covered
   by the workbook XSD**, so it cannot be reliably hand-authored — and the sample `.twbx`
   couldn't help because it embeds a `.hyper` extract, not a published-datasource ref.
   **Fix (chosen by user: REST auto-download):** fetch the published datasource's REAL
   `.tds` from `GET /sites/{site}/datasources/{id}/content?includeExtract=false`, and embed
   its exact connection/columns/metadata-records verbatim under our federated datasource
   name, injecting only a `<repository-location>` so the workbook stays LINKED to the
   published copy (not a private embed). Implementation:
   - `TableauClient.getBinary(path)` — raw-bytes GET that skips JSON parsing.
   - `src/tableau/datasources/download.ts` `downloadPublishedDatasourceTds()` — downloads,
     detects `.tdsx` (ZIP) vs raw `.tds`, unzips via `fflate`, splits out the root
     `<datasource>` inner XML + version, logs structure (connection class, column/metadata
     counts, repo-location presence) for diagnosis.
   - `generateTwb` gains `opts.publishedDatasource`; `renderDatasource` embeds the real
     inner XML + `<repository-location>` when present, else falls back to the hand-built
     binding.
   - `publishPlan` downloads the `.tds` before generating; on any failure it logs a warning
     and falls back to the hand-built binding (never blocks the publish).
   - Tests: `tests/unit/datasourceDownload.test.ts` (raw/zip/encoding/error paths) + a
     generator test for the embedded-real-datasource path. **66 tests passing.**
   - **Pending live verification:** rerun publish; the server logs the downloaded `.tds`
     structure (`tableaupilot:datasource-download`) and whether the real binding was used
     (`usedRealDatasourceDefinition`). Use those logs to refine if load still fails.
   - **8a. Download returned HTTP 406** (first live run: workbook "Test2" still failed to
     load; log showed `Could not download published datasource definition … 406 Not
     Acceptable`, so it fell back to the hand-built binding). Cause: `getBinary` sent
     `Accept: application/octet-stream`, which Tableau's file-download endpoints reject with
     406 — they negotiate on `*/*`. **Fixed:** `getBinary` now sends `Accept: '*/*'`. Next
     run should log `usedRealDatasourceDefinition: true` + the real connection class.
7. **400 [400011]** `Errors for 'Sales vs Profit by Sub-Category': The table structure was
   corrupted or malformed. Malformed expression: unable to associate operators with
   operands.` → **FIXED.** Cause: worksheets with 2+ pills on a shelf (e.g. two measures
   on rows) were emitted as bare-concatenated instance refs
   (`[sum:Sales:qk][sum:Profit:qk]`); Tableau's parser reads that as two operands with no
   operator. The real workbook wraps multiple pills in parentheses separated by ` / `
   (e.g. `([ds].[none:Category:nk] / [ds].[none:Region:nk])`). Fix: added `shelfContent()`
   which joins pills with ` / ` inside parens for 2+, leaves a single pill bare, and emits
   empty for none. Added a multi-pill generator test. **16 generator tests / 61 total.**
6. **Ground-truth alignment (sample `.twbx`).** The user supplied a real workbook
   (`sample_workbook.twbx`, built on an APAC Superstore extract, 25 worksheets + a
   dashboard) so the generator can mirror Tableau's own XML instead of guessing. Key
   findings and fixes applied to `twbGenerator.ts`:
   - **Shelves reference COLUMN INSTANCES, not raw columns.** A dimension `Category` is
     placed as `[none:Category:nk]` and a measure `SUM(Sales)` as `[sum:Sales:qk]`, and
     **each instance is declared** in `<datasource-dependencies>` alongside its base
     `<column>`. Previously we put raw `[Category]` on shelves and declared no instances,
     which is why real sheets still rendered blank. Added `aggregationCode()`,
     `dimensionInstanceName()`, `measureInstanceName()`, `shelfRef()`.
   - **Marks use `class='Automatic'`** (Tableau picks a valid mark for the fields) — the
     most robust option across chart types. Removed the hand-rolled `markClass` mapping.
   - Each `<view>` now emits `<aggregation value='true' />`; each worksheet ends with a
     `<simple-id uuid='{…}' />`.
   - **Dashboard window now carries `<viewpoints>`** (one `<viewpoint><zoom
     type='entire-view'/></viewpoint>` per placed sheet) + `<active id='-1' />`, matching
     the real file. Refactored to `computeDashboardItems()` so zones and viewpoints use
     the same placed-sheet set.
   - Tests: added coverage for column-instances/shelf refs, `<aggregation>`, `<simple-id>`,
     and the dashboard viewpoints. **60 unit/integration passing**; `tsc` clean.
5. **400 [400011]** `Dashboard references sheet 'Total Sales' which has no visual
   representation in the workbook.` → **FIXED.** Cause: an 11-worksheet plan whose layout
   referenced a blank/absent sheet (`Total Sales` had no fields on any shelf). Fix:
   `worksheetHasVisual()` filters generation to worksheets that put ≥1 field on a shelf
   (dimension/measure/KPI); the dashboard only references rendered sheets (with an
   auto-grid fallback if the layout referenced none). Added a generator test.
4. **400 [400011]** `Workbook contains a window reference expected to be a worksheet but
   resolves to a different window type.` → **FIXED.** Cause: the single worksheet shared
   its name with the dashboard (`Sales by Segment`), so the dashboard zone reference
   resolved to the **dashboard** window; also we only emitted a dashboard `<window>`.
   Fix: `buildWorksheetNameMap` de-duplicates worksheet names (and disambiguates any that
   equal the dashboard name, e.g. `→ "… (sheet)"`), zones reference the final names, and
   we now emit a `<window class='worksheet'>` per worksheet before the dashboard window.
3. **403 [500000]** `User does not have permission for action (The server encountered an
   error…)` → **worked past.** `500000` is Tableau's **generic internal-error** code, not
   a real `4030xx` authz subcode (the user is Site Admin Creator, so not authz). Fix:
   publish with **`skipConnectionCheck=true`** (skip the publish-time `<publish check>`
   connection validation) and drop the bogus `workbookType` query param. Also surfaced the
   numeric subcode + a redacted raw-body log to diagnose.
2. **400** `LayeredProtocol: Missing attribute` (with `<repository-location>`) → fixed by
   adding full `sqlproxy` attributes + a linked `<relation>` and switching to **`.twbx`**.
1. **400** `Unable to connect to the file "Superstore_DS"` during `<publish check>` →
   fixed by adding `<repository-location>` (published-datasource binding).

**Current status:** awaiting the next live retry after the 400011 window fix. If the
workbook publishes but opens with a broken datasource connection, the robust fallback is
to **download the real datasource connection XML** (REST download data source,
`includeExtract=false`) and embed that exact `<datasource>` block instead of the
hand-crafted `sqlproxy` binding.

**Manual bisect (if needed):** in Tableau Cloud web UI as `Akash2121`, create a workbook
on `Superstore_DS` and Save As into `Tableau_Agent_Folder`. Fails → datasource/project
content issue (Personal Space / prompted credentials / explicit Deny); succeeds →
API-shape case.

## Key decisions log (newest first)

- **2026-09-09 — Drop blank worksheets from generation (400011 "no visual
  representation").** `worksheetHasVisual()` gates rendering; dashboard references only
  rendered sheets (auto-grid fallback). Suite: **58 passing**.
- **2026-09-09 — Fix workbook window references (400011).** `buildWorksheetNameMap`
  guarantees worksheet names are unique and distinct from the dashboard name; dashboard
  zones reference the final names; `<windows>` now includes a `<window class='worksheet'>`
  per worksheet. Added 2 generator tests (worksheet windows; dashboard-name collision).
  Suite: **57 passing**.
- **2026-09-09 — Documentation set added.** Created `docs/{prd,architecture,design,rules,
  phases,memory}.md` as living docs; `rules.md` mandates updating them on every relevant
  change. Rewrote the existing `architecture.md` to the requested structure.
- **2026-09-09 — Surface Tableau subcode + raw body.** `extractTableauError` now returns
  `{ code, message }`; errors read `Tableau API error (<status> [<code>])` with
  `hintForTableauError`; client logs a redacted raw body preview. Revealed `403 [500000]`
  = internal error, not authz.
- **2026-09-09 — `skipConnectionCheck=true`, drop `workbookType`.** Skip Tableau's
  publish-time connection validation that was failing; file type inferred from `.twbx`.
- **2026-09-08/09 — `.twb` → `.twbx`.** Added `fflate` dependency + `twbxPackager`; publish
  the packaged workbook. Added `tests/unit/twbxPackager.test.ts` (ZIP round-trip, PK
  signature, name sanitization).
- **2026-09-08 — Published-datasource binding.** `generateTwb` emits
  `<repository-location>` (site content URL threaded from `publishPlan`) + fully-attributed
  `sqlproxy` connection + linked `<relation>`; datasource id/dbname use the REST
  `contentUrl`. Logs the redacted `<datasources>` block on publish.
- **2026-09-08 — Credential editing.** PIN-gated `updateCredentials`; `resetTableauState`
  clears token + flow on update; `CredentialsPanel` UI.
- **2026-09-08 — Planning reliability.** Dedicated tool-less `dashboardPlannerAgent` +
  `jsonPromptInjection: 'system'` + `extractJsonObject` fallback (fixes "root: Required"
  on gateways without native structured output).
- **2026-09-08 — Metadata API query fix.** Read `remoteField { dataType, role }` inside
  `DatasourceField`; capture HTTP+GraphQL errors into `unavailableReason`.
- **2026-09-08 — URL normalization.** `normalizeCloudUrl` reduces any pasted URL to the
  pod origin (fixes non-JSON/HTML login-wall responses).
- **2026-09-08 — Vite proxy scope.** Proxy `^/api/` (trailing slash) so `/api.ts` module
  import isn't intercepted.

## Running notes / gotchas

- **Kill/restart dev servers:** free ports 4000/5173/5174 (`lsof -ti :PORT | kill -9`),
  then `npm run dev`. Launch as a managed job (not `&` in a one-shot shell) so it isn't
  reaped when the shell exits.
- `tsx watch` auto-reloads on source save; usually no manual restart needed after edits.
- The API returns `404` on `/` by design (routes live under `/api/*`).
