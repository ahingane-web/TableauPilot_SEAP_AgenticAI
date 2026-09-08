/**
 * Tableau authentication helpers.
 *
 *  - `signIn`: REST API sign-in with a Personal Access Token (server-side).
 *  - `mintConnectedAppJwt`: create a short-lived Direct-Trust JWT used ONLY to
 *    authenticate the embedded Web Authoring iframe. The JWT is generated
 *    server-side from the user's Connected App secret (held in the vault) and
 *    handed to the browser as a short-lived embed token — the secret itself never
 *    leaves the server.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import type { TableauCredentials } from '../../vault/types.js';
import { TableauClient, type SignInResult } from '../tableauClient.js';

export interface TableauSession {
  client: TableauClient;
  auth: SignInResult;
  serverUrl: string;
}

/** Sign in to Tableau Cloud REST API using PAT credentials from the vault. */
export async function signIn(creds: TableauCredentials): Promise<TableauSession> {
  const client = new TableauClient(creds.cloudUrl);
  const auth = await client.signIn({
    serverUrl: creds.cloudUrl,
    siteContentUrl: creds.siteContentUrl,
    patName: creds.patName,
    patSecret: creds.patSecret,
  });
  return { client, auth, serverUrl: creds.cloudUrl };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface ConnectedAppJwtOptions {
  /** The Tableau username to embed as (usually the site user's name/email). */
  username: string;
  /** Scopes; defaults include view + authoring embed. */
  scopes?: string[];
  /** Lifetime in seconds (Tableau caps at ~10 minutes). */
  expiresInSeconds?: number;
}

/**
 * Mint a Connected App (Direct Trust) JWT for embedding.
 * Requires the user to have configured a Connected App in their vault credentials.
 */
export function mintConnectedAppJwt(creds: TableauCredentials, opts: ConnectedAppJwtOptions): { token: string; expiresAt: number } {
  const ca = creds.connectedApp;
  if (!ca?.clientId || !ca.secretId || !ca.secretValue) {
    throw new AppError('UNSUPPORTED_OPERATION', 'No Tableau Connected App configured for embedded authoring.', {
      hint: 'Add a Connected App (clientId, secretId, secretValue) to your saved credentials, or use interactive Tableau login in the embed.',
    });
  }
  const scopes = opts.scopes ?? ['tableau:views:embed', 'tableau:views:embed_authoring'];
  const lifetime = Math.min(opts.expiresInSeconds ?? 540, 600); // cap at 10 min
  const now = Math.floor(Date.now() / 1000);
  const exp = now + lifetime;

  const header = { alg: 'HS256', typ: 'JWT', kid: ca.secretId, iss: ca.clientId };
  const payload = {
    iss: ca.clientId,
    exp,
    jti: randomUUID(),
    aud: 'tableau',
    sub: opts.username,
    scp: scopes,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', ca.secretValue).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${signature}`, expiresAt: exp * 1000 };
}
