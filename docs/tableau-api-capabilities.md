# Tableau API Capabilities — what is and isn't automatable

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

## Category A — Automate via REST

Sign-in, discovery, metadata, permission checks, publishing, and verification are all
performed through the official Tableau REST + Metadata APIs in `src/tableau`.

## Category A-gen — Compile a plan into a real workbook

A validated `DashboardPlan` is compiled into a `.twb` (`src/tableau/authoring/twbGenerator.ts`)
that references the **locked published datasource** and lays out worksheets + a
dashboard. The `.twb` is published via REST, which creates a **real** workbook. See
[authoring-limitations.md](./authoring-limitations.md) for the honest scope of this
generation.

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
