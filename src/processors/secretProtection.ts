/**
 * Secret-protection input processor (defense-in-depth).
 *
 * By construction, credentials never enter the agent's context — tools resolve the
 * session server-side and return only non-secret data. This Mastra input processor
 * is a second line of defense: it scans the inbound message context for
 * secret-looking material and aborts the run if any is found, so a secret can never
 * reach the model even if something upstream misbehaves.
 */
import type { InputProcessor } from '@mastra/core/processors';
import { looksLikeSecret } from '../utils/redaction.js';
import { logger } from '../utils/logger.js';

const log = logger.child('processor:secret-protection');

export const secretProtectionProcessor: InputProcessor = {
  id: 'secret-protection',
  name: 'secret-protection',
  processInput(args) {
    const context = args as unknown as { messages: unknown; abort: (reason?: string) => never };
    let serialized = '';
    try {
      serialized = JSON.stringify(context.messages ?? '');
    } catch {
      serialized = '';
    }
    if (serialized && looksLikeSecret(serialized)) {
      log.warn('Blocked model input containing secret-like content.');
      context.abort('Input blocked: content resembling a credential/secret was detected.');
    }
    // No mutation — return the original message list.
    return context.messages as never;
  },
};
