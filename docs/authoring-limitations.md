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

## The honest hand-off

For anything in Category C, TableauPilot:

1. Publishes the best-effort workbook (Category A-gen) to the approved project.
2. Opens the **real** Web Authoring embed on that workbook (Category B).
3. Tells you precisely what to finish by hand (e.g. "drag `Sales` to Rows on the
   *Monthly Trend* sheet; set mark type to Line").
4. Listens for the real `WorkbookPublished` event when you save.

This keeps the experience genuinely useful **and** honest.
