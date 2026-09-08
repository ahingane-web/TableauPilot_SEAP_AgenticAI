# Authentication

There are two distinct Tableau authentications, plus the local vault identity.

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

## Token boundaries (summary)

| Secret | Where it lives | Ever in browser? | Ever in LLM? |
|---|---|---|---|
| Vault PIN | user-entered, transient | for entry only | never |
| PAT secret | vault + session (server) | never | never |
| REST auth token | session (server) | never | never |
| Connected App secret | vault + session (server) | never | never |
| Minted embed JWT | server → browser (short-lived) | yes (by design) | never |
