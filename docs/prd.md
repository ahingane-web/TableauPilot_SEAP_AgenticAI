# PRD — TableauPilot AI

> Living document. Update this whenever product scope, requirements, or success
> criteria change. Last updated: 2026-09-09.

## 1. Summary

TableauPilot AI is an agentic AI copilot for **Tableau Cloud Web Authoring**, built on
the [Mastra](https://mastra.ai) framework. A user describes a dashboard in natural
language; the system plans it against the user's **real** published-datasource
metadata, requires **human approval**, generates a real workbook (`.twb`/`.twbx`),
**publishes it to Tableau Cloud via REST**, opens the **real** Web Authoring embed for
refinement, and **verifies** the published result via REST — returning the actual
Tableau URL.

The product is deliberately **honest about capability boundaries**: it never fakes an
editor and never claims success it cannot verify.

## 2. Goals

- **NL → real dashboard.** Turn a natural-language request into a published Tableau
  Cloud dashboard grounded in the user's real datasource fields.
- **Hybrid authoring.** AI plan → server-side `.twb`/`.twbx` generation → REST publish
  → embedded **real** Web Authoring → REST verification.
- **Human-in-the-loop.** No publish without an explicit approval gate.
- **Secret safety.** Per-user Tableau credentials stored in a 6-digit-PIN-encrypted
  server-side vault; secrets never reach the browser or the LLM.
- **Dynamic discovery.** No hardcoded projects, datasources, or fields — everything is
  discovered live per session.
- **Grounded planning.** Every field referenced in a plan is validated against live
  metadata before anything is generated or published (no fabricated fields).
- **Observability.** Redacting structured logs + spans/events; the same brain runs in
  Mastra Studio for inspection.

## 3. Non-goals

- **No fake editor.** Programmatic shelf/mark/filter manipulation via the Embedding JS
  API is **not supported by Tableau** and is never simulated (see
  [authoring-limitations.md](./authoring-limitations.md)).
- **No pixel-perfect fidelity claim.** Generated workbooks are best-effort scaffolds to
  be finished in the real embed.
- **No Python.** TypeScript/Node.js only (see
  [python-dependency-decision.md](./python-dependency-decision.md)).
- **No storing user Tableau secrets in `.env`** or in the browser/localStorage.
- **No multi-tenant billing / user management** beyond the local vault (out of scope for
  this build).

## 4. Personas

- **Analyst / Dashboard author (primary).** Knows their data, wants to go from an idea
  to a starting dashboard fast, then refine in the real Tableau editor.
- **Tableau site admin / platform owner.** Cares that secrets are safe, permissions are
  respected, and the tool never does anything unverifiable.
- **Developer / operator.** Runs the app locally or self-hosted; inspects agent runs and
  workflows via Mastra Studio.

## 5. Core user flows

1. **Vault onboarding.** Register username + 6-digit PIN → save Tableau credentials
   (cloud URL, site, PAT, optional Connected App). Returning users **unlock** with PIN.
2. **Connect & lock.** Connect to Tableau Cloud (PAT sign-in) → pick **target project**
   → pick and **lock** a published datasource (immutable for the session).
3. **Plan.** Describe the dashboard → agent inspects the locked datasource's real fields
   → returns a Zod-validated `DashboardPlan` → field validation vs live metadata.
4. **Approve.** Review the plan; **approve** by its hash (integrity gate).
5. **Execute.** Generate `.twb` → package `.twbx` → **REST publish** to the approved
   project → **REST verify** (site/project/workbook/view/datasource/URL).
6. **Refine.** The published workbook opens in the **real** Web Authoring embed for
   Category C hand-finishing; saves captured via real `WorkbookPublished` events.

## 6. Functional requirements

- **FR1 Vault.** Register/unlock with username + 6-digit PIN; AES-256-GCM at rest;
  lockout after N failed attempts; save + PIN-gated update of credentials; logout.
- **FR2 Connectivity.** PAT sign-in to Tableau Cloud; token cached ≤55 min; URL
  normalization to the pod origin.
- **FR3 Discovery.** List projects/datasources/workbooks/views (pagination-aware).
- **FR4 Metadata.** Read datasource fields via the Metadata API (GraphQL); surface an
  actionable `unavailableReason` when the API can't return fields.
- **FR5 Permissions.** Advisory checks for project publish, datasource access, workbook
  edit (Tableau Cloud remains the true enforcement point).
- **FR6 Planning.** NL → structured `DashboardPlan` (tool-less planner agent, robust
  JSON extraction fallback); validate all fields against live metadata.
- **FR7 Guards.** Datasource-lock immutability, target-project match, approval-hash
  integrity — enforced server-side before publish.
- **FR8 Generation.** Compile plan → `.twb` XML → package `.twbx`; reference the
  published datasource via `<repository-location>` + `sqlproxy` connection.
- **FR9 Publish.** Multipart REST publish to the exact approved project, with
  `skipConnectionCheck=true` to avoid publish-time connection-validation failures.
- **FR10 Verify.** REST GET the published workbook; resolve the real Tableau URL; check
  project match.
- **FR11 Embed.** Provide embed info (URL + optional short-lived Connected App JWT) for
  the real Web Authoring viz.
- **FR12 Honesty.** Never claim success without REST verification; explicit Category C
  hand-off.

## 7. Non-functional requirements

- **Security.** Secrets server-side only; deep redaction in logs/errors; opaque session
  id to the browser; sanitized error envelope. See [security.md](./security.md).
- **Reliability.** Structured-output planning works across Anthropic-compatible gateways
  (JSON prompt injection + fallback parsing).
- **Portability.** TypeScript/Node ≥ 20.9; no Python; minimal dependencies.
- **Observability.** Redacting logger + spans/events; Mastra Studio parity.
- **Testability.** Unit + integration (Vitest) and non-destructive E2E (Playwright);
  `tsc`/lint/build must stay clean.
- **Performance.** Token caching; pagination; no unnecessary re-sign-in.

## 8. Success criteria

- A user can go from NL request → **verified** published Tableau Cloud dashboard, with
  the returned URL resolving to the real workbook in the approved project.
- No secret ever appears in the browser, logs, errors, or LLM I/O.
- Every field in a published plan exists in live metadata (0 fabricated fields).
- Publishing either succeeds **or** fails with an actionable, subcode-aware error.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all pass.

## 9. Open questions / risks

- **Published-datasource binding fidelity.** Hand-generated `.twb` binding to a
  published datasource is version-sensitive; may need a "download real connection XML
  and embed it" strategy if `skipConnectionCheck` publishing still opens with a broken
  connection. (Tracked in [memory.md](./memory.md).)
- **Metadata API availability.** Sites without Metadata API / un-indexed datasources
  degrade planning grounding; handled with `unavailableReason` but limits quality.
