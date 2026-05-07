/**
 * PII sanitizer for error-tracking context. Mirror of the GDW Next.js
 * sanitizer (`grupodewhatsapp/lib/observability/sanitize.ts`) and the
 * moderation-worker twin. Kept byte-identical in rules so error properties
 * scrub the same way across all three runtimes that share the PostHog
 * project.
 */

const DROP_KEYS = new Set([
  'body',
  'text',
  'caption',
  'message',
  'content',
  'media',
  'payload',
  'pushname',
  'phone',
  'phonenumber',
  'msisdn',
]);

const MAX_STRING_LEN = 200;
const PHONE_RE = /^\+?\d{8,15}$/;
const JID_RE = /@(s\.whatsapp\.net|g\.us|lid|broadcast)$/i;

function sanitizeString(value: string): string {
  if (PHONE_RE.test(value)) return '[phone]';
  const jidMatch = value.match(JID_RE);
  if (jidMatch) return `[jid:${jidMatch[1]}]`;
  if (value.length > MAX_STRING_LEN) {
    return value.slice(0, MAX_STRING_LEN) + '...[truncated]';
  }
  return value;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[depth-limit]';
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(k.toLowerCase())) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {};
  const result = sanitizeValue(context, 0);
  return (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
}
