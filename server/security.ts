import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const DEFAULT_DEV_SECRET = crypto
  .createHash('sha256')
  .update(process.env.SESSION_SECRET || 'classroom48-local-session-secret-key-v1')
  .digest('hex');

export function getSessionSecret(): string {
  return process.env.SESSION_SECRET || DEFAULT_DEV_SECRET;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, expectedHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(rawToken: string): string {
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(rawToken)
    .digest('hex');
}

export function signCookieValue(rawToken: string): string {
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(rawToken)
    .digest('base64url');
  return `${rawToken}.${sig}`;
}

export function verifyCookieValue(signedValue: string | undefined): string | null {
  if (!signedValue || !signedValue.includes('.')) return null;
  const lastDot = signedValue.lastIndexOf('.');
  const rawToken = signedValue.slice(0, lastDot);
  const providedSig = signedValue.slice(lastDot + 1);
  if (!rawToken || !providedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(rawToken)
    .digest('base64url');

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? rawToken : null;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    cookies[key] = val;
  }
  return cookies;
}

export function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match?.[1]?.trim() || undefined;
}

export function sanitizeText(input: unknown, maxLen = 2000): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

export function sanitizeUsername(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

interface RateBucket {
  timestamps: number[];
}

export class SlidingWindowRateLimiter {
  private buckets = new Map<string, RateBucket>();
  private lastPrune = Date.now();

  constructor(
    public readonly windowMs: number,
    public readonly maxRequests: number
  ) {}

  check(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    if (now - this.lastPrune > Math.max(this.windowMs, 60_000)) {
      for (const [k, b] of this.buckets.entries()) {
        b.timestamps = b.timestamps.filter((t) => t > cutoff);
        if (b.timestamps.length === 0) this.buckets.delete(k);
      }
      this.lastPrune = now;
    }

    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= this.maxRequests) {
      const oldest = bucket.timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.buckets.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - bucket.timestamps.length),
      retryAfterSec: 0,
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export function rateLimitMiddleware(
  limiter: SlidingWindowRateLimiter,
  keyFn: (req: Request) => string,
  message = 'Bạn đã thao tác quá nhanh. Vui lòng thử lại sau ít phút.'
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const result = limiter.check(key);
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      res.status(429).json({
        error: message,
        retryAfterSec: result.retryAfterSec,
      });
      return;
    }
    next();
  };
}
