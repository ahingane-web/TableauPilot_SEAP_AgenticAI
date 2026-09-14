# Authoring Limitations (Category C) — read this

TableauPilot is built to be **truthful about capability boundaries**. This document
states exactly what the automated pipeline does and does not guarantee.

## What the automated pipeline guarantees

- A **real workbook is created** in your Tableau Cloud site, in the **exact project**
  you approved, connected to the **locked published datasource**.
- Its existence, project, views, connected datasource, and URL are **verified via the
  REST API** before any success is reported. URLs are taken from Tableau responses —
  never guessed.
- The `.twb` encodes your approved plan: worksheets (with chart types, dimensions,
  measures, filters, calculated fields) and a dashboard layout.

## What it does NOT guarantee (and why)

Programmatic `.twb` generation against an **arbitrary** published datasource is
best-effort. The precise internal field references, connection binding, and mark
encodings that Tableau Desktop/Server produce are complex and partially undocumented.
Therefore:

- The generated worksheets may need **field re-binding or visual tuning** once opened.
- Complex encodings (dual axis, advanced table calcs, LOD-heavy calculations, precise
  formatting) are **not fully materialized** by the generator.

**None of this is faked.** Verification confirms the workbook exists and is
published; it does not claim pixel-perfect fidelity.

## Category C — explicitly unsupported programmatically

The Embedding API v3 authoring component (`TableauAuthoringViz`) exposes **lifecycle
events only**. There is **no supported API** to, from code:

- add/remove worksheets,
- drag fields onto Rows/Columns/Marks shelves,
- configure mark types, colors, sizes, labels,
- create or edit filters/parameters interactively.

Any product claiming to do these via the embed JS API is misrepresenting the platform.

## Salesforce extract datasources — honest scope

The Salesforce connector publishes an **extract-backed** datasource built from a fresh
Salesforce query at publish time (all selected objects, with relationships or physical
joins). Honest boundaries:

- **Row caps.** Each object is capped (`HYPER_MAX_ROWS`); large objects are truncated, not
  fully mirrored.
- **Server-side refresh of multi-object datasources.** A Tableau-side refresh REBUILDS the
  extract with Tableau's own engine and can collapse a relationship/join datasource to the
  first table ("migrating data… only 1st table"). The bundled extract published by the app
  always contains all tables. If this recurs, gate the post-publish refresh to
  single-object builds (see [memory.md](./memory.md)).
- Credentials are never embedded in the extract; refreshability relies on the saved
  Salesforce credential on Tableau Cloud.

## Excel extract datasources — honest scope

The Excel connector publishes an **extract-only** datasource built from an uploaded
workbook at publish time (all selected sheets, with relationships or physical joins).
Honest boundaries:

- **Static extract — no refresh.** There is no live connection and no embedded credential,
  so the datasource cannot be refreshed on Tableau Cloud. The bundled `.hyper` IS the data;
  to update it, re-upload and re-publish.
- **Row caps.** Each sheet is capped (`HYPER_MAX_ROWS`); large sheets are truncated.
- **Type inference is best-effort.** Column types are inferred by sampling non-empty cells
  (number → integer/real, Date → date/datetime, boolean, else text); mixed-type columns
  fall back to text. There is no per-column type override.
- **Name sanitization.** Sheet and column names are sanitized to identifier-safe ids
  (`[A-Za-z][A-Za-z0-9_]*`) so they flow through the shared `.tds`/`.hyper` pipeline; the
  original names are preserved as captions/labels for display.

## The honest hand-off

For anything in Category C, TableauPilot:

1. Publishes the best-effort workbook (Category A-gen) to the approved project.
2. Opens the **real** Web Authoring embed on that workbook (Category B).
3. Tells you precisely what to finish by hand (e.g. "drag `Sales` to Rows on the
   *Monthly Trend* sheet; set mark type to Line").
4. Listens for the real `WorkbookPublished` event when you save.

This keeps the experience genuinely useful **and** honest.
