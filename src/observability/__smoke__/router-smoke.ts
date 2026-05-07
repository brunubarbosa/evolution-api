/**
 * Standalone smoke for the PostHog router. Evolution has no test framework
 * configured (`npm test` points at a non-existent file), so we ship this as
 * a runnable assertion script instead. Run with:
 *
 *   POSTHOG_API_KEY=test-only npx tsx src/observability/__smoke__/router-smoke.ts
 *
 * The PostHog API key only needs to be set so the router constructs its
 * client; no events actually flush because we don't await shutdown.
 *
 * Verifies:
 *   - allowlist accepts forwarded kinds, rejects noisy ones
 *   - rate limit suppresses bursts of the same (kind, instance) within window
 *   - rate limit lets distinct instances through
 *   - sanitizer redacts PII keys before reaching captureException props
 */

import { __TEST__ } from '../posthog-router';
import { sanitizeContext } from '../sanitize';

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures += 1;
  }
}

console.log('— allowlist —');
assert(__TEST__.shouldForward({ kind: 'autoheal.permanent-stop', instance: 'a' }), 'forwards autoheal.permanent-stop');
assert(
  __TEST__.shouldForward({ kind: 'process.uncaughtException', instance: null }),
  'forwards process.uncaughtException',
);
assert(!__TEST__.shouldForward({ kind: 'webhook.delivery', instance: 'a' }), 'rejects webhook.delivery (noise)');
assert(!__TEST__.shouldForward({ kind: 'heartbeat', instance: null }), 'rejects heartbeat (noise)');
assert(
  !__TEST__.shouldForward({ kind: 'baileys.mutex.timeout', instance: 'a' }),
  'rejects baileys.mutex.timeout (recoverable noise)',
);
assert(!__TEST__.shouldForward({ kind: 'unknown.kind', instance: 'a' }), 'rejects kinds not in allowlist');

console.log('— rate limit —');
__TEST__.resetRateLimit();
assert(
  __TEST__.shouldForward({ kind: 'baileys.handler.error', instance: 'i1' }),
  'first baileys.handler.error for instance i1 forwards',
);
assert(
  !__TEST__.shouldForward({ kind: 'baileys.handler.error', instance: 'i1' }),
  'second baileys.handler.error for i1 within window suppressed',
);
assert(
  __TEST__.shouldForward({ kind: 'baileys.handler.error', instance: 'i2' }),
  'distinct instance i2 not affected by i1 rate limit',
);
__TEST__.resetRateLimit();
assert(
  __TEST__.shouldForward({ kind: 'baileys.handler.error', instance: 'i1' }),
  'reset clears bucket — i1 forwards again',
);

console.log('— sanitizer —');
const sanitized = sanitizeContext({
  body: 'real message text',
  text: 'more body',
  payload: { whatever: 'hi' },
  pushName: 'João',
  phone: '+5511999999999',
  group_jid: '120363111111111@g.us',
  user_jid: '5511999999999@s.whatsapp.net',
  keep: 'visible',
  count: 42,
});
assert(sanitized.body === '[redacted]', 'body redacted');
assert(sanitized.text === '[redacted]', 'text redacted');
assert(sanitized.payload === '[redacted]', 'payload redacted');
assert(sanitized.pushName === '[redacted]', 'pushName redacted');
assert(sanitized.phone === '[redacted]', 'phone redacted');
assert(sanitized.group_jid === '[jid:g.us]', 'group jid suffix-tagged');
assert(sanitized.user_jid === '[jid:s.whatsapp.net]', 'user jid suffix-tagged');
assert(sanitized.keep === 'visible', 'unrelated keys preserved');
assert(sanitized.count === 42, 'numeric values preserved');

console.log(failures === 0 ? '\nAll assertions passed.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
