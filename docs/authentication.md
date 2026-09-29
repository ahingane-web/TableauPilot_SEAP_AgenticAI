# Authentication

There are two distinct Tableau authentications, plus the local vault identity — and,
for the Salesforce connector, a separate Salesforce sign-in (§4). The Excel connector
requires **no sign-in at all** (§5), and the Google BigQuery connector uses a separate
Google browser OAuth sign-in (§6).

## 1. Local vault identity (username + 6-digit PIN)

Used only to gate access to the server-side credential vault. It is **not** a Tableau
credential. See [security.md](./security.md) for the crypto.

- **Register:** new username + PIN → creates an encrypted vault record.
- **Unlock:** existing username + PIN → decrypts credentials into an in-memory session.

## 2. Tableau REST — Personal Access Token (PAT)

All REST + Metadata API calls sign in with a **PAT** (`patName` + `patSecret`) against
your `cloudUrl` + `siteContentUrl`. The PAT secret lives only in the vault and the
in-memory session; the REST auth token Tableau returns is cached server-side (~55 min)
and **never** sent to the browser or the LLM.

Create a PAT: Tableau Cloud → *My Account Settings* → *Personal Access Tokens*.

## 3. Embedded Web Authoring — Connected App JWT (optional)

The real Web Authoring embed authenticates one of two ways:

- **Connected App (Direct Trust) — seamless.** If you stored a Connected App
  `clientId`, `secretId`, `secretValue`, and the Tableau `username` to impersonate,
  the server mints a short-lived **HMAC-SHA256 JWT** (`src/tableau/auth`) at embed
  time and passes it to `TableauAuthoringViz`. The secret never leaves the server; only
  the minted JWT reaches the browser.
- **Interactive login — fallback.** With no Connected App configured, the embed loads
  without a token and Tableau prompts the user to log in inside the iframe.

Set up a Connected App: Tableau Cloud → *Settings* → *Connected Apps* → *Direct Trust*.
Grant the `tableau:views:embed` (and authoring) scope and register your app's domain.

## 4. Salesforce connector sign-in (extract datasource builder)

Only used by the Salesforce data-source builder; unrelated to Tableau auth above.

- **Username / password (+ optional security token).** SOAP login (`src/salesforce/
  client.ts` `login()`) returns a session used for REST `describe`/`query`. After login,
  `resolveLatestApiVersion()` picks the org's highest available REST API version.
- **Browser OAuth (PKCE) — optional.** With `SALESFORCE_OAUTH_CLIENT_ID` (+ secret)
  configured, the user signs in via Salesforce; `src/salesforce/oauth.ts` runs the
  PKCE authorize → token-exchange → userinfo flow (`/api/connectors/salesforce/oauth/*`).
- Salesforce credentials/tokens are **transient and in-memory** (`session.connectors.
  salesforce`), cleared after publish, and **never embedded** in the published extract.
  The published datasource refreshes via the **saved Salesforce credential** on Tableau
  Cloud (embedded on the connection by username match). See [security.md](./security.md).

## 5. Excel connector (extract datasource builder)

The Excel connector has **no authentication step**. The user uploads an `.xlsx`, which is
parsed **in memory** (`src/excel/excelClient.ts`); there is no external system to sign in
to and no credential is ever collected. The parsed sheets are held transiently on
`session.connectors.excel` and cleared after publish. Because the datasource is published
**extract-only**, nothing is embedded and there is no saved credential to refresh against.
See [security.md](./security.md).

## 6. Google BigQuery connector sign-in (live or extract datasource builder)

Only used by the BigQuery data-source builder; unrelated to Tableau auth above.

- **Browser OAuth (PKCE) — required.** The user clicks **Sign in with Google**;
  `src/bigquery/oauth.ts` runs the Google Authorization-Code + PKCE flow (authorize →
  token-exchange → `userinfo`) via `/api/connectors/bigquery/oauth/*`. Scopes mirror Tableau
  Desktop's own BigQuery connector: `openid email`, `.../auth/bigquery`, and
  `.../auth/cloudplatformprojects.readonly` (project listing only — narrower than
  `cloud-platform.read-only`); `access_type=offline` + `prompt=consent` yields a refresh token.
- **OAuth client is dynamic, vault-saved, or server-configured.** `bigQueryOauthStart` resolves
  the client id/secret in priority order: **per-request (UI-entered) → the user's vault-saved
  client (`TableauCredentials.bigQueryOAuth`) → `GOOGLE_OAUTH_*`**. `/api/connectors` reports
  `oauthConfigured`; when the server has no env client, `BigQueryBuild` collects the **Client ID
  (+ optional secret) in the UI** (with an in-UI how-to for creating one) and can **save it
  encrypted in the user's vault** via `POST /api/connectors/bigquery/oauth/client` so it is
  prefilled next time. The vault stores only this reusable app-registration credential; the
  per-user access/refresh token is still transient (`session.connectors.bigquery`), never
  persisted or logged. The connection **email is never asked** — it is read from `userinfo`.
- The Google access/refresh token and email are **transient and in-memory**
  (`session.connectors.bigquery`), cleared after publish; the pending-OAuth PKCE state lives
  only in `src/bigquery/oauthStore.ts` with a short TTL. Tokens are never logged or persisted.
- Both **live and extract** datasources embed the signed-in account's **saved BigQuery OAuth
  credential** on Tableau Cloud (matched by email); Tableau — not this app — refreshes it.

## Token boundaries (summary)

| Secret | Where it lives | Ever in browser? | Ever in LLM? |
|---|---|---|---|
| Vault PIN | user-entered, transient | for entry only | never |
| PAT secret | vault + session (server) | never | never |
| REST auth token | session (server) | never | never |
| Connected App secret | vault + session (server) | never | never |
| Minted embed JWT | server → browser (short-lived) | yes (by design) | never |
| Salesforce creds / OAuth token | session only (transient, cleared after publish) | never | never |
| Salesforce OAuth client secret | server env (if configured) | never | never |
| Google BigQuery OAuth token | session only (transient, cleared after publish) | never | never |
| Google OAuth client id/secret | vault (encrypted, if user saves) or server env | never | never |
