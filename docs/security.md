# Security

> Living document. Last updated: 2026-10-01.

## Threat model & goals

1. Secrets (Tableau PAT secret, Connected App secret, REST token; connector source
   credentials/tokens such as Salesforce creds, the Google BigQuery OAuth token, and the
   Data Cloud OAuth/SOAP session + CDP tokens; the Snowflake session token + password; and any saved OAuth client secret) must **never** reach the
   browser, the LLM, logs, traces, Mastra memory, or workflow state.
2. Credentials at rest must be unreadable without the user's PIN.
3. A 6-digit PIN is low entropy, so brute force must be economically infeasible and
   rate-limited.

## Credential vault

- **Identity:** `username` + **6-digit PIN**.
- **Key derivation:** `scrypt(PIN + VAULT_PEPPER + per-user salt)` → 32-byte key.
  - `VAULT_PEPPER` is a long server-only secret from the environment. It is **not**
    stored with the vault, so an attacker who steals `vault.json` still cannot derive
    keys without also stealing the server env.
  - Per-user random salt is stored with the record (defends against rainbow tables).
- **At rest:** `AES-256-GCM` with a random IV per encryption and an auth tag. A wrong
  PIN fails GCM authentication → decryption is rejected (no oracle beyond pass/fail).
- **PIN verifier:** a known constant is encrypted at register time; unlock decrypts it
  to validate the PIN without decrypting the real secrets first.
- **Rate limiting / lockout:** repeated failures lock the account for a cool-down
  window to make online PIN guessing infeasible.
- **File perms:** `vault.json` is written `0o600` under `DATA_PATH`.
- **PIN-gated mutation:** even inside an unlocked session, changing or deleting the
  saved Tableau blob or a connector login section requires the PIN again. Tableau delete
  sets `record.creds = null` and clears in-memory credentials + connector state.
  Per-section delete (Salesforce / BigQuery client / Data Cloud / Snowflake) clears only
  that nested object. The SPA never receives secrets — only a `CredentialSummary`.
  **Login materials** (Salesforce password, Snowflake password, Data Cloud Connected App
  secret, BigQuery OAuth client secret) may live in the PIN-encrypted blob. Live
  connector **session tokens** still never persist.

## Session model

- On unlock, decrypted credentials live **only in memory** in a `Session`, keyed by an
  opaque random `sessionId`.
- The browser holds **only** the `sessionId` (via `x-session-id`) — never a secret.
- Sessions expire (TTL) and are swept; on destroy, secret buffers/strings are scrubbed.
- Tools receive the `sessionId` from `requestContext` and resolve the session
  **server-side**; the LLM only ever sees the opaque id and non-secret summaries.

## Secret boundaries in code

- **Redaction:** `src/utils/redaction.ts` deep-redacts by key name and by secret-value
  regex. The logger (`src/utils/logger.ts`) and observability (`src/observability`)
  pass everything through it.
- **Error sanitization:** `src/utils/errors.ts` converts thrown values into a
  `SanitizedError` (code + safe message + hint) before anything reaches a client.
- **LLM input processor:** `secretProtectionProcessor` scans inbound messages for
  secret-looking patterns and aborts — defense in depth so a user can't paste a token
  into the chat and have it echoed.
- **Memory:** Mastra Memory stores non-sensitive preferences only; no credentials.
- **Tool I/O:** tools return names/counts/metadata only; never tokens or PAT secrets.
- **Frontend:** `app/api.ts` stores only the session id in `localStorage`; the client
  type surface (`app/types.ts`) contains no secret fields. Connector passwords are typed
  on the Build connect forms (**Save Creds in Vault** posts them; **Use Saved Creds**
  never reads them back). Vault shows non-secret summaries only.

## Salesforce connector

- **Vault login materials (optional).** Salesforce username/password may be saved
  encrypted in the user's PIN vault (`TableauCredentials.salesforce`) from the Salesforce
  connect form (**Save Creds in Vault**) and reused with **Use Saved Creds**. Live SOAP/OAuth sessions remain
  **in-memory** on `session.connectors.salesforce` and are **cleared once publishing
  completes**. They are never sent to the browser or the LLM.
- **Never embedded in the extract.** The published `.hyper`/`.tds` contains **no**
  Salesforce credentials. Refreshability on Cloud comes from the publisher's **saved
  Salesforce OAuth credential** (embedded on the datasource connection by username match),
  which is a Tableau-Cloud-side stored credential — not a secret this app holds.
- **OAuth (PKCE).** The interactive browser flow uses PKCE; the pending `state`/verifier
  is stored transiently and swept (`oauthStore.ts`). The client secret (if configured)
  stays server-side.
- **Hyper sidecar hygiene.** `hyperPackager.ts` passes the sidecar only **temp-file
  paths** on argv — never row data or secrets — so nothing sensitive appears in the
  process table; the temp directory is always removed (even on failure).

## Excel connector

- **No credentials at all.** The Excel connector authenticates to **nothing** — it only
  parses an uploaded workbook. There is no external system to sign in to, so no secret is
  ever collected, held, or embedded.
- **In-memory parse.** The uploaded `.xlsx` bytes are parsed **in memory** by
  `exceljs` (`src/excel/excelClient.ts` `parseWorkbook(buffer)`); the raw upload is never
  written to disk. The typed, identifier-safe sheets + rows are held transiently on
  `session.connectors.excel` and **cleared once publishing completes** (`session.connectors
  = undefined`), never persisted to the vault and never sent to the LLM.
- **Extract-only, nothing embedded.** The published `.hyper`/`.tds` contains **no**
  connection credential; the bundled extract IS the data (viewable immediately, no
  server-side refresh). There is no live connection to authenticate.
- **Same sidecar hygiene.** Extract packaging reuses `hyperPackager.ts`, so the sidecar
  still receives only **temp-file paths** on argv and the temp directory is always removed.

## Google BigQuery connector

- **Token is transient only.** The Google OAuth **access/refresh token** and the signed-in
  email are held **in-memory** on `session.connectors.bigquery`, used only to list
  projects/datasets/tables, describe columns, and (for an extract) query rows, and are
  **cleared once publishing completes**. The token is never persisted to the vault, never sent
  to the browser or the LLM, and never logged (`src/bigquery/*` redacts).
- **Client id/secret are the only persisted piece — and only if the user opts in.** The OAuth
  **client** id/secret (the app-registration credential, analogous to the Tableau Connected App
  secret — *not* a user data token) may be saved **encrypted in the user's vault**
  (`TableauCredentials.bigQueryOAuth`, AES-256-GCM under the PIN key) so it need not be re-entered.
  The Sign-in step collects Client ID/secret; **Save Creds in Vault** stores the client only
  (not the Google access token). It never reaches the browser (the client only learns the non-secret client id + a "has secret"
  flag) and is resolved server-side in the order request → vault → `GOOGLE_OAUTH_*`.
- **OAuth (PKCE).** The browser flow uses PKCE; the pending `state`/verifier + client id/secret
  live in a short-TTL, single-use map (`src/bigquery/oauthStore.ts`) that routes the header-less
  callback back to the originating session. Scopes are least-privilege (`openid email`,
  `.../auth/bigquery`, `.../auth/cloudplatformprojects.readonly`), matching Tableau's own connector.
- **Email is derived, not asked.** The connection username/email comes from OpenID `userinfo`;
  it is used to match the publisher's **saved Google BigQuery OAuth credential** on Tableau Cloud
  (embedded by username on the datasource connection) — a Cloud-side stored credential, not a
  secret this app holds. **No Google credential is ever baked into the `.tds`/`.hyper`.**
- **Same sidecar hygiene.** Extract mode reuses `hyperPackager.ts` (temp-file paths on argv only,
  temp dir always removed); **Live** mode publishes a bare `.tds` and touches no `.hyper`.

## Salesforce Data Cloud connector

- **Login materials may be vaulted; session tokens are not.** My Domain + Connected App
  (and optional SOAP username/password) can be saved in `TableauCredentials.dataCloud`
  from the Data Cloud connect form.
  The Salesforce OAuth or SOAP session and the Data Cloud CDP token stay
  **in-memory** on `session.connectors.datacloud` and are **cleared once publishing
  completes**.
- **OAuth with CDP scopes; SOAP is fallback.** The UI signs in with Salesforce in a popup
  (`src/datacloud/oauth.ts` requests `api cdp_query_api` only — extra scopes on the authorize
  URL cause `OAUTH_APPROVAL_ERROR_GENERIC` when they are not selected on the Connected App).
  Consumer Key/Secret stay in the form or `SALESFORCE_OAUTH_*`. SOAP `Salesforce.login` remains
  for password fallback; SOAP session ids often fail `POST /services/a360/token` (HTTP 500).
- **Saved-credential match, not the SOAP password.** Both live and extract datasources embed
  the publisher's **saved Salesforce Data Cloud OAuth credential** on Tableau Cloud (matched
  by username). **No Data Cloud credential is ever baked into the `.tds`/`.hyper`.**
- **Same sidecar hygiene.** Extract mode reuses `hyperPackager.ts` (temp-file paths on argv
  only, temp dir always removed); **Live** mode publishes a bare `.tds` and touches no `.hyper`.

## Snowflake connector

- **Session token is transient; login may be vaulted.** Username/password can be saved in
  `TableauCredentials.snowflake` from the Snowflake connect form. The Snowflake **session token** (and the in-memory copy
  of the password used for that session) stay on `session.connectors.snowflake` and are
  **cleared once publishing completes**. They are never sent to the browser or the LLM.
- **Username/password, not OAuth.** The UI collects server URL / warehouse / username /
  password; `src/snowflake/client.ts` uses session REST login. No new env vars.
- **Password is embedded at publish.** Both live and extract datasources send Tableau REST
  `connectionCredentials` with name + password (`embed=true`, not `oAuth`). **No Snowflake
  password is written into the `.tds`/`.hyper` XML.**
- **Same sidecar hygiene.** Extract mode reuses `hyperPackager.ts`; **Live** mode publishes
  a bare `.tds` and touches no `.hyper`.

## Operational guidance

- Set a strong, unique `VAULT_PEPPER`; rotating it invalidates all vaults (by design).
- Serve over HTTPS in production and restrict `CORS_ORIGINS`.
- The minted embed JWT is intentionally short-lived; do not lengthen its expiry.
- `.env` and the vault data directory are git-ignored — keep them out of source control.

## Residual risks (honest)

- The minted embed JWT is necessarily present in the browser to authenticate the embed;
  it is short-lived and scoped, but is the one credential that crosses the boundary.
- `VAULT_PEPPER` compromise + `vault.json` theft + online guessing could, in theory,
  attack a PIN offline. Keep the pepper server-only and the data directory protected.
