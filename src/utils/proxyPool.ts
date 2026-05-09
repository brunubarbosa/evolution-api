// Rotating proxy pool integration.
//
// A "proxy pool" provider exposes a single gateway host plus a range of ports;
// each port pins one upstream IP for a sticky session. We pick a random port
// per WhatsApp instance so each session gets its own IP, then rotate the port
// when the upstream signals that IP is no longer usable.
//
// Error handling:
//   ROTATE_ON_STATUS    → that port's IP is blocked; pick a new port and retry.
//   FATAL_ON_STATUS     → auth/quota/malformed; flip a process-wide kill switch
//                         so other instances don't pile on after a quota breach.
//   TRANSIENT_ON_STATUS → upstream hiccup; retry with backoff on the same port.
//
// Status codes match conventions used by major residential providers (e.g. 403
// for IP-blocked, 407 for proxy auth/quota). Adjust the constants below if
// your provider uses a different taxonomy.

import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';

const logger = new Logger('ProxyPool');

// Tunable behavior — adjust here, not at call sites.
export const ROTATE_ON_STATUS: readonly number[] = [403];
export const FATAL_ON_STATUS: readonly number[] = [400, 407];
export const TRANSIENT_ON_STATUS: readonly number[] = [502, 503];
export const PORT_BAD_TTL_MS = 15 * 60 * 1000;
export const TRANSIENT_BACKOFFS_MS: readonly number[] = [1000, 2000, 4000];
const PORT_PICK_ATTEMPTS = 5;

export type ProxyPoolConfig = {
  ENABLED: boolean;
  HOST: string;
  PROTOCOL: 'http' | 'https';
  USERNAME?: string;
  PASSWORD?: string;
  PORT_MIN: number;
  PORT_MAX: number;
};

export type ProxyPoolEntry = {
  enabled: true;
  host: string;
  port: string;
  protocol: 'http' | 'https';
  username: string;
  password: string;
};

let processDisabled = false;

const portHealth = new Map<number, number>();

export function isProxyPoolEnabled(configService: ConfigService): boolean {
  if (processDisabled) return false;
  const cfg = configService.get<ProxyPoolConfig>('PROXY_POOL');
  return Boolean(cfg?.ENABLED && cfg.HOST && cfg.USERNAME && cfg.PASSWORD);
}

export function recentlyBadPorts(): Set<number> {
  const cutoff = Date.now() - PORT_BAD_TTL_MS;
  const live = new Set<number>();
  for (const [port, ts] of portHealth) {
    if (ts >= cutoff) live.add(port);
    else portHealth.delete(port);
  }
  return live;
}

export function markPortBad(port: number | string): void {
  const n = typeof port === 'number' ? port : parseInt(port, 10);
  if (!Number.isFinite(n)) return;
  portHealth.set(n, Date.now());
}

export function pickProxyPoolPort(cfg: ProxyPoolConfig, exclude?: Set<number>): number {
  const min = cfg.PORT_MIN;
  const max = cfg.PORT_MAX;
  const range = max - min + 1;
  for (let i = 0; i < PORT_PICK_ATTEMPTS; i++) {
    const port = min + Math.floor(Math.random() * range);
    if (!exclude?.has(port)) return port;
  }
  // All attempts landed on bad ports — accept the last one rather than block
  // the connect path. recentlyBadPorts will eventually expire it.
  return min + Math.floor(Math.random() * range);
}

export function buildProxyPoolEntry(cfg: ProxyPoolConfig, port: number): ProxyPoolEntry {
  if (!cfg.USERNAME || !cfg.PASSWORD) {
    throw new Error('Proxy pool credentials missing');
  }
  return {
    enabled: true,
    host: cfg.HOST,
    port: String(port),
    protocol: cfg.PROTOCOL,
    username: cfg.USERNAME,
    password: cfg.PASSWORD,
  };
}

export type ProxyErrorClass = 'transient' | 'rotate' | 'fatal' | 'unknown';

export function classifyProxyStatus(status: number | undefined | null): ProxyErrorClass {
  if (status == null) return 'unknown';
  if (TRANSIENT_ON_STATUS.includes(status)) return 'transient';
  if (ROTATE_ON_STATUS.includes(status)) return 'rotate';
  if (FATAL_ON_STATUS.includes(status)) return 'fatal';
  return 'unknown';
}

export function classifyProxyError(err: unknown): ProxyErrorClass {
  return classifyProxyStatus(extractStatus(err));
}

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, any>;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  if (e.response && typeof e.response.status === 'number') return e.response.status;
  if (e.output && typeof e.output.statusCode === 'number') return e.output.statusCode;
  return undefined;
}

export function disableForProcess(reason: string): void {
  if (processDisabled) return;
  processDisabled = true;
  logger.error(`[proxy-pool] DISABLED for process: ${reason}`);
}

export function isProcessDisabled(): boolean {
  return processDisabled;
}

export type WithProxyRetryOpts = {
  onRotate?: () => void | Promise<void>;
  onFatal?: (err: unknown) => void | Promise<void>;
  label?: string;
  port?: number | string;
};

export async function withProxyRetry<T>(fn: () => Promise<T>, opts: WithProxyRetryOpts = {}): Promise<T> {
  const label = opts.label ?? 'proxy-pool';
  let rotated = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const cls = classifyProxyError(err);
      const status = extractStatus(err);
      logger.warn(`[proxy-pool] ${label} error class=${cls} status=${status ?? '-'} port=${opts.port ?? '-'}`);

      if (cls === 'transient' && attempt < TRANSIENT_BACKOFFS_MS.length) {
        await sleep(TRANSIENT_BACKOFFS_MS[attempt]);
        continue;
      }
      if (cls === 'rotate' && !rotated && opts.onRotate) {
        rotated = true;
        await opts.onRotate();
        continue;
      }
      if (cls === 'fatal') {
        await opts.onFatal?.(err);
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
