# Authentication

> Living document. Last updated: 2026-10-01.

There are two distinct Tableau authentications, plus the local vault identity — and,
for the Salesforce connector, a separate Salesforce sign-in (§4). The Excel connector
requires **no sign-in at all** (§5), the Google BigQuery connector uses a separate
Google browser OAuth sign-in (§6), and Salesforce Data Cloud uses Salesforce browser
OAuth with CDP scopes then exchanges a CDP token (§7; SOAP password login is a fallback).
The Snowflake connector uses username/password session login (§8).

## 1. Local vault identity (username + 6-digit PIN)

Used only to gate access to the server-side credential vault. It is **not** a Tableau
credential. See [security.md](./security.md) for the crypto.

- **Register:** new username + PIN → creates an encrypted vault record.
- **Unlock:** existing username + PIN → decrypts credentials into an in-memory session.
- **Edit / delete:** PIN-gated even inside an unlocked session. Tableau
  (`POST /api/vault/credentials/update` and `/delete`) and per-connector sections
  (`POST /api/vault/connectors/{salesforce,bigquery,datacloud,snowflake}` + `/delete`).
  Tableau delete clears the whole encrypted blob; section delete clears only that login.
  The left-top **Vault** panel keeps Tableau save/edit/delete. Connector logins are
  entered on the Build connect forms (**Save Creds in Vault** / **Use Saved Creds**);
  Vault shows compact non-secret summaries and PIN delete. **Show Vault** / **Hide Vault**
  sits in the Vault header (body hidden by default after Tableau credentials are saved;
  auto-opens if they are not). Setup/Plan stay if Tableau credentials are saved. Secrets are
  never returned to the browser.

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
  The connect form is always visible. **Save Creds in Vault** stores login materials
  (not the SOAP session). **Use Saved Creds** prefills URL/username and connects with
  an empty body so the route merges vault secrets — passwords never return to the browser.
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
  (+ optional secret) on the Sign-in step** (with an in-UI how-to for creating one). **Save Creds
  in Vault** stores the client only (not the Google access token). **Use Saved Creds** prefills
  the client id and starts OAuth with an empty body so the route merges the vault client.
  The vault stores only this reusable app-registration credential; the per-user access/refresh
  token is still transient (`session.connectors.bigquery`), never persisted or logged. The
  connection **email is never asked** — it is read from `userinfo`.
- The Google access/refresh token and email are **transient and in-memory**
  (`session.connectors.bigquery`), cleared after publish; the pending-OAuth PKCE state lives
  only in `src/bigquery/oauthStore.ts` with a short TTL. Tokens are never logged or persisted.
- Both **live and extract** datasources embed the signed-in account's **saved BigQuery OAuth
  credential** on Tableau Cloud (matched by email); Tableau — not this app — refreshes it.

## 7. Salesforce Data Cloud connector sign-in (live or extract datasource builder)

- **Browser OAuth with CDP scopes** (`api cdp_query_api`). `DataCloudBuild` opens a Salesforce
  popup (`display=popup`, no `prompt=login`); `src/datacloud/oauth.ts` builds the authorize URL
  (Salesforce `oauth.ts` internals unchanged). The My Domain URL field starts empty (tooltip
  only — no default host); a BigQuery-style collapsible how-to covers Connected App setup,
  scopes, callback URL, and `OAUTH_APPROVAL_ERROR_GENERIC`. The access token is exchanged at `POST /services/a360/token`
  (`grant_type=urn:salesforce:grant-type:external:cdp`). Consumer Key/Secret are pasted in
  the UI (or `SALESFORCE_OAUTH_*`). The callback URI is the **same** Salesforce CRM
  callback (`SALESFORCE_OAUTH_REDIRECT_URI`); the shared handler tries the Data Cloud
  pending store first. SOAP username/password remains as a fallback — SOAP session ids
  often fail a360 with HTTP 500. Login fields stay visible. **Save Creds in Vault** stores
  My Domain + Connected App (optional SOAP). **Use Saved Creds** prefills non-secret
  fields and starts OAuth with an empty body so the route merges vault secrets.
- The OAuth or SOAP session + CDP token are **transient and in-memory** (`session.connectors.datacloud`),
  cleared after publish. Tokens are never logged or persisted.
- Both **live and extract** datasources embed the publisher's **saved Salesforce Data Cloud
  OAuth credential** on Tableau Cloud (matched by username); Tableau — not this app — refreshes
  it. The SOAP password is never what Tableau Cloud uses for live queries or extract refresh.

## 8. Snowflake connector sign-in (live or extract datasource builder)

- **Username/password** against the account host. `SnowflakeBuild` collects server URL /
  warehouse / username / password; the server calls `POST /session/v1/login-request`
  (`requestId`, `CLIENT_ENVIRONMENT`, `Accept: application/snowflake`). No new env vars and
  no OAuth popup. Role UI is omitted (`service=''` in the `.tds`). Login fields stay
  visible. **Save Creds in Vault** stores login materials. **Use Saved Creds** prefills
  server/warehouse/username and connects with an empty body so the route merges the vault
  password.
- The session token + password are **transient and in-memory** (`session.connectors.snowflake`),
  cleared after publish. They are never logged or persisted.
- Both **live and extract** datasources embed the Snowflake **username/password** on the
  Tableau Cloud connection at publish time (not a saved OAuth credential). Live runs no
  refresh; Extract triggers `refreshDatasourceNow` (best-effort).

## Token boundaries (summary)

| Secret | Where it lives | Ever in browser? | Ever in LLM? |
|---|---|---|---|
| Vault PIN | user-entered, transient | for entry only | never |
| PAT secret | vault + session (server) | never | never |
| REST auth token | session (server) | never | never |
| Connected App secret | vault + session (server) | never | never |
| Minted embed JWT | server → browser (short-lived) | yes (by design) | never |
| Salesforce SOAP/OAuth session | session only (transient, cleared after publish) | never | never |
| Salesforce / Data Cloud / Snowflake login materials | vault + session | never returned | never |
| Salesforce OAuth client secret | server env (if configured) | never | never |
| Google BigQuery OAuth token | session only (transient, cleared after publish) | never | never |
| Google OAuth client id/secret | vault (encrypted, if user saves) or server env | never | never |
| Data Cloud OAuth / SOAP session + CDP token | session only (transient, cleared after publish) | never | never |
| Snowflake session token + password | session only (transient, cleared after publish) | never | never |
