# Authentication

There are two distinct Tableau authentications, plus the local vault identity — and,
for the Salesforce connector, a separate Salesforce sign-in (§4).

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
