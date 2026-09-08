# Python Dependency Decision — none

**Decision: TableauPilot uses no Python. The entire system is TypeScript / Node.js.**

## Why the question comes up

Some Tableau tooling ecosystems lean on Python (e.g. the Hyper API for `.hyper`
extract manipulation, or `tableauserverclient`). An earlier concept for this project
even referenced local `.twbx`/extract handling (the now-unused `HYPERD_PATH`,
`UPLOADS_PATH`, `WORKSPACE_PATH` env fields).

## Why we don't need it

Our hybrid strategy never manipulates extracts locally:

- **Auth / discovery / metadata / permissions / publish / verify** — all done through
  the Tableau **REST + Metadata APIs** over HTTPS, which are language-agnostic. Node's
  `fetch` + a small multipart helper cover publishing.
- **Workbook creation** — we generate a **`.twb` (plain XML)**, not a packaged
  `.twbx`/`.hyper`. XML generation is pure string work in TypeScript
  (`src/tableau/authoring/twbGenerator.ts`). No Hyper API required because the workbook
  references a **published datasource** that already lives in Tableau Cloud.
- **Embedding** — the Embedding API v3 is browser JavaScript.
- **JWT minting** — HMAC-SHA256 via Node's built-in `crypto`; no external/Python lib.

## Benefits

- One language, one toolchain (tsc/vite/vitest/playwright), one runtime.
- No cross-language IPC, no Python packaging in deploys, smaller attack surface.
- Mastra is a TypeScript framework, so the agent, tools, and workflows stay in-process.

If a future feature genuinely required local extract creation, the Hyper API (which has
a C++/Java/Python surface) would be the trigger to revisit this — but the current scope
does not.
