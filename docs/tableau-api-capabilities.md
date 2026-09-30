# Tableau API Capabilities — what is and isn't automatable

> Living document. Last updated: 2026-09-30.

TableauPilot is deliberately honest about where each operation can happen. We map
every capability to one of five buckets.

| Capability | How | Automated? |
|---|---|---|
| Authenticate (REST) | PAT sign-in | ✅ Category A (REST) |
| Discover sites/projects/workbooks/views/datasources | REST list endpoints | ✅ Category A |
| Read datasource fields (dimensions/measures/dates) | Metadata API (GraphQL) | ✅ Category A |
| Permission checks | REST permissions endpoints | ✅ Category A (advisory) |
| **Build a workbook/dashboard** | Generate `.twb` XML → REST publish | ✅ Category A-gen |
| Publish to a specific project | REST multipart publish (guarded) | ✅ Category A |
| Verify a publish (existence/URL/views) | REST re-query | ✅ Category A |
| Open real Web Authoring | Embedding API v3 `TableauAuthoringViz` | ✅ Category B (human refines) |
| Programmatically add shelves/marks/filters via the embed JS API | — | ❌ Category C (NOT supported) |
| Human authoring in the real embed | User interacts with Tableau UI | ✅ Category B |
| **Build a Salesforce extract datasource** | Local `.hyper` + `.tds` → REST publish `.tdsx` | ✅ Category A-gen |
| Model Salesforce objects (relationships / physical joins) | Deterministic `.tds` generation | ✅ Category A-gen |
| **Build an Excel extract-only datasource** | `exceljs` parse → local `.hyper` + `excel-direct` `.tds` → REST publish `.tdsx` (no credential/refresh) | ✅ Category A-gen |
| **Build a Google BigQuery datasource (live or extract)** | BigQuery REST describe/query → `class='bigquery'` OAuth `.tds` (live) or local `.hyper` `.tdsx` (extract) → REST publish + embed OAuth cred | ✅ Category A-gen |
| **Build a Salesforce Data Cloud datasource (live or extract)** | Data Cloud metadata/Query API → `class='salesforce-genie'` OAuth `.tds` (live) or local `.hyper` `.tdsx` (extract) → REST publish + embed Data Cloud OAuth cred | ✅ Category A-gen |
| **Build a Snowflake datasource (live or extract)** | Snowflake session SQL → `class='snowflake'` Username Password `.tds` (live) or local `.hyper` `.tdsx` (extract) → REST publish + embed password | ✅ Category A-gen |
| Embed saved credential on a datasource connection | REST Update-Connection (`embedPassword`) | ✅ Category A |
| Refresh a published extract | REST `POST /datasources/{id}/refresh` | ✅ Category A |
| Server-side extract creation from a live datasource | `createExtract` background job | ❌ unsupported on target site (see below) |

## Category A — Automate via REST

Sign-in, discovery, metadata, permission checks, publishing, and verification are all
performed through the official Tableau REST + Metadata APIs in `src/tableau`.

## Category A-gen — Compile a plan into a real workbook

A validated `DashboardPlan` is compiled into a `.twb` (`src/tableau/authoring/twbGenerator.ts`)
that references the **locked published datasource** and lays out worksheets + a
dashboard. The `.twb` is published via REST, which creates a **real** workbook. See
[authoring-limitations.md](./authoring-limitations.md) for the honest scope of this
generation.

## Category A-gen — Compile a Salesforce datasource into a real extract

The Salesforce connector reads objects/fields (SOAP + REST), queries rows, and compiles a
`.tds` (single, relationships object-graph, or physical join) plus a locally-materialized
`.hyper` extract (Python Hyper sidecar) packaged as a `.tdsx`, then publishes it via REST.
After publish it embeds the saved Salesforce credential and triggers an extract refresh.

**Required: the object-model manifest.** An extract-backed `.tds` MUST open with a
`<document-format-change-manifest>` declaring `ObjectModelExtractV2` +
`ObjectModelEncapsulateLegacy` (plus `ObjectModelTableType`, `SchemaViewerObjectModel`, and —
for the relationships model — `ObjectModelRelationshipPerfOptions`). Omitting it makes Tableau
load the extract in **legacy** mode and flatten the multi-table `<object-graph>` into a single
**"Migrated Data"** table (so a "relationship" build renders as one merged table). Both working
references carry this block; the generators now emit it for every mode.

## Category A-gen — Compile an Excel workbook into an extract-only datasource

The Excel connector parses an uploaded `.xlsx` (`exceljs`), treats each **sheet** like a
Salesforce object, and compiles the SAME `.tds` shapes (single / relationships object-graph /
physical join) + a locally-materialized `.hyper` `.tdsx` — the only structural difference is a
`class='excel-direct'` named-connection (with the uploaded `filename`) and `table='[<sheet>$]'`
relations, reconciled against `reference/sample ds Excel Connector.tds`. The same object-model
manifest requirement applies.

**Extract-only publish.** Unlike Salesforce, an Excel datasource is published with **no
`connectionCredentials`** and **no refresh** — the bundled `.hyper` IS the data (equivalent to
Tableau's "include external files → extract"). The `excel-direct` `filename` is retained only
for lineage and is never read on Tableau Cloud; the datasource is viewable immediately and is not
refreshable without re-publishing. This reuses `publishDatasource` (which already makes
`connectionCredentials` optional), skipping `embedDatasourceConnectionCredential`/
`refreshDatasourceNow`.

## Category A-gen — Compile a Google BigQuery datasource (live OR extract)

The BigQuery connector authenticates via **Google browser OAuth (PKCE)** and reads projects/
datasets/tables/columns over pure-fetch BigQuery + Cloud Resource Manager REST. It compiles the
SAME `.tds` shapes (single / relationships object-graph / physical join) as Salesforce/Excel,
but with a `class='bigquery'`, `authentication='oauth'`, `connection-dialect='google-sql'`
named-connection and `[<project>.<dataset>].[<table>]` relations, reconciled against
`reference/BigQueryDataset{Live,Extract}.tds`. Because BigQuery column names may contain spaces/
hyphens, the generator keeps the **real** name as the connection `remote-name`/`remote-alias`
and assigns disambiguated `local-name`s.

**Two materializations:**
- **Live** — publish a bare `.tds` (no `<extract>`; manifest omits `ObjectModelExtractV2`;
  object-graph carries only `context=''`). Tableau queries BigQuery directly over the embedded
  OAuth credential; the app runs **no refresh** after publish.
- **Extract** — query rows (`jobs.query` against the billing project), materialize a local
  `.hyper` `.tdsx` (Python Hyper sidecar), publish, embed the OAuth credential, and trigger
  `refreshDatasourceNow` (best-effort — the bundled `.hyper` already holds queried data).

**Credential embed (both shapes).** After publish, `embedDatasourceConnectionCredential` embeds
the signed-in Google account's **saved BigQuery OAuth credential** on Tableau Cloud (matched by
email, `oAuth: true`), so the datasource is connectable/refreshable by Tableau — the app's own
Google token stays transient and in-memory.

## Category A-gen — Compile a Salesforce Data Cloud datasource (live OR extract)

The Data Cloud connector authenticates via **Salesforce SOAP login** (imported, unmodified)
then a CDP token exchange (`POST /services/a360/token`). It lists data spaces and objects
(DMO / DLO / Calculated Insights) over pure-fetch Data Cloud HTTP (`src/datacloud/client.ts`).
It compiles the SAME `.tds` shapes (single / relationships object-graph / physical join) as
the other connectors, but with `class='salesforce-genie'`, `authentication='oauth'`,
`dbname='a360/{pod}/{tenantId};{dataSpace}'`, `warehouse` = data space, `server` =
`*.c360a.salesforce.com`, and `[public].[apiName]` relations, reconciled against
`reference/DataCloud{Live,Extract}DS.tds`. Field API names stay as `remote-name`; collisions
become `ssot__Id__c (Account Contact)`. Object-id is `{caption}_{MD5(apiName)}` (spaces kept).
Do **not** reuse `generateSalesforceTds`.

**Two materializations:**
- **Live** — publish a bare `.tds` (no `<extract>`; manifest omits `ObjectModelExtractV2`;
  object-graph carries only `context=''`). Tableau queries Data Cloud directly over the
  embedded saved OAuth credential; the app runs **no refresh** after publish.
- **Extract** — query rows (Data Cloud Query API), materialize a local `.hyper` `.tdsx`
  (Python Hyper sidecar), publish, embed the OAuth credential, and trigger
  `refreshDatasourceNow` (best-effort — the bundled `.hyper` already holds queried data).

**Credential embed (both shapes).** After publish, `embedDatasourceConnectionCredential`
embeds the publisher's **saved Salesforce Data Cloud OAuth credential** on Tableau Cloud
(matched by username, `oAuth: true`). The SOAP password is never what Tableau refreshes with.

**Why build the `.hyper` locally?** Server-side extract creation from a live datasource
was tried and failed on the target Cloud site — `createExtract` returns *"REST API does
not support background job type :create_extracts"*, and constraining the query via `.tds`
metadata hit `sf:MALFORMED_QUERY`/unsupported-job errors. Writing the `.hyper` locally
(what Tableau Desktop does) is the only reliable path, and the Hyper API has no Node
binding — hence the one Python sidecar (see
[python-dependency-decision.md](./python-dependency-decision.md)).

## Category A-gen — Snowflake datasource (live or extract)

Same pattern as BigQuery/Data Cloud, with Snowflake conventions:

- **Live** — federated `.tds` (`class='snowflake'`, `authentication='Username Password'`,
  `[DATABASE].[SCHEMA].[TABLE]` relations). Tableau Cloud queries Snowflake directly.
- **Extract** — `.tdsx` with a local `.hyper` (Python Hyper sidecar) plus
  `refreshDatasourceNow` (best-effort). Object-id is
  `{TABLE} ({DATABASE}.{TABLE})_{MD5(db.schema.table)}` (stable vs Hyper; not Desktop's
  proprietary hash). `<extract object-id>` is the **first table**.

**Credential embed (both shapes).** Snowflake uses Tableau REST `connectionCredentials`
with name + password (`embed=true`, **not** `oAuth`). `embedDatasourceConnectionCredential`
is **not** called (that helper is OAuth saved-cred matching for Salesforce, BigQuery, and
Data Cloud). No Snowflake password is written into the `.tds` XML.

## Category B — Real Web Authoring embed

After publishing, the workbook opens in the genuine Tableau Cloud Web Authoring UI via
the Embedding API v3 `TableauAuthoringViz` component. This is where a human refines the
dashboard. We capture the real lifecycle events (`WorkbookPublished`,
`WorkbookPublishedAs`, `WorkbookReadyToClose`).

## Category C — NOT supported programmatically

The Embedding API v3 exposes **lifecycle events only** for authoring — it does not
provide a supported API to programmatically add worksheets, drag fields onto shelves,
configure marks, or build filters from JavaScript. TableauPilot never fakes these. It
hands the task to the human inside the real embed with concrete guidance.

## Why generate a `.twb` at all?

The REST API's "publish workbook" requires an actual workbook file — there is no
"create empty workbook from a published datasource and add sheets" REST endpoint. So
to create a real, non-empty dashboard automatically, we must generate a workbook file.
That generation is best-effort (Category A-gen) and is always followed by the real
embed for refinement and by REST verification for truth.
