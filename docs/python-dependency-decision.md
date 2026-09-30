# Python Dependency Decision — scoped to extract building

> Living document. Last updated: 2026-09-30.

**Decision: TableauPilot is TypeScript / Node.js, with ONE narrow exception — a Python
Hyper API sidecar used solely to materialize `.hyper` extracts for the Build-datasource
connectors (Salesforce, Excel, Google BigQuery, Salesforce Data Cloud, and Snowflake —
the latter three only when the user picks "Extract"; a Live datasource needs no sidecar).**

## Background

The system was originally 100% Node with no Python. Auth, discovery, metadata,
permissions, publishing, verification, workbook `.twb` authoring, JWT minting, and
embedding are all done through the Tableau REST/Metadata APIs and pure-TypeScript XML
generation — no Python needed for any of that, and that remains true.

## Why the exception exists

Salesforce datasources must be **extract-backed**. Two Node-only paths were tried and
failed:

1. Publish a live datasource and call REST `createExtract` server-side. On the target
   Tableau Cloud site this returns `REST API does not support background job type
   :create_extracts` — the job cannot be polled or completed.
2. Constrain the server-side extract query via `.tds` column metadata. Still failed
   (`sf:MALFORMED_QUERY` / unsupported job type).

Writing a `.hyper` locally (what Tableau Desktop does) is the only reliable option, and
the **Tableau Hyper API has no Node.js binding** (Python / Java / C++ / .NET only). This
is exactly the trigger this document always named for revisiting the no-Python stance.

## Scope of the Python usage

- One script: [`scripts/hyper/build_tdsx.py`](../scripts/hyper/build_tdsx.py). It reads a
  column schema + streamed rows from temp files, writes an extract `.hyper`, and zips it
  with the generated `.tds` into a `.tdsx`. That is the entire surface.
- Invoked as a subprocess by
  [`src/tableau/publishing/hyperPackager.ts`](../src/tableau/publishing/hyperPackager.ts).
  All connectors reuse this one sidecar: the Excel connector parses the workbook in
  TypeScript (`exceljs`), the BigQuery connector queries rows over REST (`jobs.query`), and
  the Data Cloud connector queries rows over the Data Cloud Query API, and the Snowflake
  connector queries rows over session SQL, each feeding the same
  schema + rows into it. All connector access, `.tds`/`.twb` authoring, and publishing stay
  in TypeScript. (A BigQuery, Data Cloud, or Snowflake **Live** datasource skips the sidecar entirely —
  it publishes a bare `.tds` with no `.hyper`.)
- Installed into a local virtualenv via `npm run setup:hyper` (`.venv-hyper/`, gitignored).
  The interpreter path is configurable via `HYPER_PYTHON`.
- No secrets or row data are passed on argv — only temp file paths.

## Boundaries preserved

- The extract `.hyper` is materialized locally from a fresh Salesforce query at publish
  time. **Salesforce credentials are never embedded in the extract itself.** After
  publish, the orchestration embeds the publisher's **saved Salesforce OAuth credential**
  on the datasource connection and triggers an extract refresh so the datasource is
  refreshable on Cloud (see [design.md](./design.md) §5b and [memory.md](./memory.md)).
  The Excel connector materializes the `.hyper` the same way, but publishes it
  **extract-only** — no credential is embedded and no refresh is triggered (the bundled
  extract is the data). The BigQuery connector (Extract mode) materializes the `.hyper` from a
  live `jobs.query`, then embeds the publisher's **saved Google BigQuery OAuth credential** and
  triggers a refresh — like Salesforce; BigQuery **Live** embeds the credential but skips the
  local `.hyper`/refresh (Tableau queries BigQuery directly). The Data Cloud connector (Extract
  mode) materializes the `.hyper` from the Data Cloud Query API, then embeds the publisher's
  **saved Salesforce Data Cloud OAuth credential** and triggers a refresh; Data Cloud **Live**
  embeds the credential but skips the local `.hyper`/refresh (Tableau queries Data Cloud
  directly). The Snowflake connector (Extract mode) materializes the `.hyper` from session
  SQL, then embeds username/password and triggers a refresh; Snowflake **Live** embeds the
  password but skips the local `.hyper`/refresh (Tableau queries Snowflake directly).
- XML is still generated deterministically in TypeScript, never by the LLM.
- If a future feature needs richer local extract logic, extend the sidecar rather than
  spreading Python across the codebase.
