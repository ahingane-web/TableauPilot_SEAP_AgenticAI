# Security

## Threat model & goals

1. Tableau secrets (PAT secret, Connected App secret, REST token) must **never** reach
   the browser, the LLM, logs, traces, Mastra memory, or workflow state.
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
  type surface (`app/types.ts`) contains no secret fields.

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
