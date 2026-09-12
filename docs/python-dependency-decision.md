# Python Dependency Decision — scoped to extract building

**Decision: TableauPilot is TypeScript / Node.js, with ONE narrow exception — a Python
Hyper API sidecar used solely to materialize Salesforce `.hyper` extracts.**

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
  All Salesforce access, `.tds`/`.twb` authoring, and publishing stay in TypeScript.
- Installed into a local virtualenv via `npm run setup:hyper` (`.venv-hyper/`, gitignored).
  The interpreter path is configurable via `HYPER_PYTHON`.
- No secrets or row data are passed on argv — only temp file paths.

## Boundaries preserved

- The published extract embeds **no credentials** (static extract: viewable, not
  refreshable on Cloud without re-publishing).
- XML is still generated deterministically in TypeScript, never by the LLM.
- If a future feature needs richer local extract logic, extend the sidecar rather than
  spreading Python across the codebase.
