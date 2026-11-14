/**
 * Sky Palette — Privacy-Preserving Rate Limiter (Cloudflare Workers)
 * 
 * Uses SHA-256 with a secret salt (IP_SALT) to track request frequencies
 * without ever storing or logging raw IP addresses or personal identifiers.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

// In-memory token bucket for fast edge rate limiting per worker isolate
const rateLimitCache = new Map<string, { count: number; resetAt: number }>();

/**
 * Hash an IP address with a secret salt to preserve privacy
 */
export async function hashIp(ip: string, salt: string = 'sky-salt-default'): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${ip}:${salt}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * Rate limit a request based on action and hashed client identifier
 * @param identifier Hashed client IP
 * @param maxRequests Maximum requests allowed in window
 * @param windowSeconds Window duration in seconds
 */
export function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowSeconds: number
): RateLimitResult {
  const now = Math.floor(Date.now() / 1000);
  const key = `${identifier}:${windowSeconds}`;
  const record = rateLimitCache.get(key);

  if (!record || record.resetAt <= now) {
    rateLimitCache.set(key, { count: 1, resetAt: now + windowSeconds });
    return { allowed: true, remaining: maxRequests - 1, resetSeconds: windowSeconds };
  }

  if (record.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetSeconds: Math.max(1, record.resetAt - now)
    };
  }

  record.count += 1;
  return {
    allowed: true,
    remaining: maxRequests - record.count,
    resetSeconds: Math.max(1, record.resetAt - now)
  };
}
