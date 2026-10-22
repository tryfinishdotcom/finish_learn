import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

type Env = Record<string, string | undefined>;

// Matches Memberstack's own server SDK (@memberstack/admin 1.7.0, verifyToken):
// signing keys from Memberstack's published JWKS, issuer api.memberstack.com, `exp`
// required, audience = the Memberstack app id. The site's app id is the default; set
// MEMBERSTACK_APP_ID to override it.
// The SDK reads the key set over plain HTTP from the bucket's website endpoint
// (http://member-jwt.s3-website-us-east-1.amazonaws.com/). The same object is served
// over HTTPS at the URL below (byte-identical, checked 2026-10-22), so the keys cannot
// be swapped in transit. MEMBERSTACK_JWKS_URL overrides it.
const DEFAULT_JWKS_URI = 'https://member-jwt.s3.amazonaws.com/jwks.json';
const ISSUER = 'https://api.memberstack.com';
const DEFAULT_APP_ID = 'app_cmde998dl011d0wx92d1xae1y';

export function memberstackConfig(env: Env): { jwksUri: string; issuer: string; audience: string } {
  return {
    jwksUri: env.MEMBERSTACK_JWKS_URL || DEFAULT_JWKS_URI,
    issuer: ISSUER,
    audience: env.MEMBERSTACK_APP_ID || DEFAULT_APP_ID,
  };
}

// Signing keys per key source. Known keys are served from memory and refreshed after
// 10 minutes. A token naming an unknown key id triggers at most one refetch per 30 s,
// so a stream of made-up key ids cannot crowd out the refresh of the real key. If a
// refresh fails, the keys already loaded stay in use for at most an hour after their
// last successful fetch; past that, or when a key id is unknown while the source is
// failing, verification cannot complete and callers answer 503.
const KEYS_MAX_AGE_MS = 10 * 60 * 1000;
const KEYS_MAX_TRUST_MS = 60 * 60 * 1000;
const REFETCH_MIN_INTERVAL_MS = 30 * 1000;
const COLD_RETRY_MS = 5 * 1000; // no keys loaded yet and the last fetch failed
type KeySet = { keys: Map<string, string>; fetchedAt: number };
const keySets = new Map<string, KeySet>();
const lastFetchAttempt = new Map<string, number>();
const lastFetchFailed = new Map<string, boolean>();
const inflight = new Map<string, Promise<KeySet>>();

let clock = () => Date.now();
// Tests only: move time without waiting.
export function setClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

function fetchKeySet(uri: string): Promise<KeySet> {
  let pending = inflight.get(uri);
  if (!pending) {
    lastFetchAttempt.set(uri, clock());
    pending = jwksRsa({ jwksUri: uri, cache: false, rateLimit: false, timeout: 5000 })
      .getSigningKeys()
      .then(
        (signingKeys) => {
          const set: KeySet = { keys: new Map(), fetchedAt: clock() };
          for (const k of signingKeys) set.keys.set(k.kid ?? '', k.getPublicKey());
          keySets.set(uri, set);
          lastFetchFailed.set(uri, false);
          return set;
        },
        (error) => {
          lastFetchFailed.set(uri, true);
          throw error;
        }
      )
      .finally(() => inflight.delete(uri));
    inflight.set(uri, pending);
  }
  return pending;
}

function lookup(set: KeySet, kid: string | undefined): string | undefined {
  if (kid !== undefined) return set.keys.get(kid);
  return set.keys.size === 1 ? [...set.keys.values()][0] : undefined;
}

async function signingKeyFor(uri: string, kid: string | undefined): Promise<string | undefined> {
  let set = keySets.get(uri);
  const now = clock();
  if (!set && !inflight.has(uri) && now - (lastFetchAttempt.get(uri) ?? 0) < COLD_RETRY_MS) {
    throw new KeySourceUnavailableError('key fetch failed moments ago');
  }
  const mayFetch = now - (lastFetchAttempt.get(uri) ?? 0) >= REFETCH_MIN_INTERVAL_MS;
  const stale = !set || now - set.fetchedAt > KEYS_MAX_AGE_MS;
  if (!set || (mayFetch && (stale || lookup(set, kid) === undefined))) {
    try {
      set = await fetchKeySet(uri);
    } catch (error) {
      if (!set) throw new KeySourceUnavailableError(error);
    }
  }
  if (clock() - set!.fetchedAt > KEYS_MAX_TRUST_MS) {
    throw new KeySourceUnavailableError('signing keys older than an hour and the key source is failing');
  }
  const key = lookup(set!, kid);
  if (!key && lastFetchFailed.get(uri)) {
    throw new KeySourceUnavailableError('unknown key id while the key source is failing');
  }
  return key;
}

// Thrown when Memberstack's signing keys cannot be fetched (network error, key source
// down). The token may well be valid, so callers answer 503, not 401: a 401 tells the
// client to sign the learner in again, which would not help.
export class KeySourceUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Memberstack signing keys unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'KeySourceUnavailableError';
  }
}

// Keys must arrive over HTTPS; plain HTTP is only accepted from this machine (tests).
function isTrustedKeySource(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

export async function verifyMemberstackToken(token: string): Promise<jwt.JwtPayload & { id: string }> {
  const { jwksUri, issuer, audience } = memberstackConfig(process.env);
  if (!isTrustedKeySource(jwksUri)) {
    throw new KeySourceUnavailableError(`refusing insecure key source ${jwksUri}`);
  }
  let keySourceError: KeySourceUnavailableError | undefined;
  const getKey: jwt.GetPublicKeyOrSecret = (header, callback) => {
    signingKeyFor(jwksUri, header.kid).then(
      (key) => (key ? callback(null, key) : callback(new Error('unknown signing key'))),
      (err) => {
        if (err instanceof KeySourceUnavailableError) keySourceError = err;
        callback(err);
      }
    );
  };

  const decoded = await new Promise<jwt.JwtPayload>((resolve, reject) => {
    jwt.verify(token, getKey, { algorithms: ['RS256'], issuer, audience }, (err, payload) => {
      if (err) reject(keySourceError ?? err);
      else resolve(payload as jwt.JwtPayload);
    });
  });
  // jsonwebtoken only checks `exp` when the claim is present. Require it, so a token
  // minted without an expiry cannot be accepted forever.
  if (typeof decoded.exp !== 'number') {
    throw new jwt.JsonWebTokenError('jwt has no exp claim');
  }
  if (typeof decoded.id !== 'string' || decoded.id === '') {
    throw new jwt.JsonWebTokenError('jwt has no member id');
  }
  // Member tokens carry type "member" (SDK docs). Reject any other declared type.
  if (decoded.type !== undefined && decoded.type !== 'member') {
    throw new jwt.JsonWebTokenError('jwt is not a member token');
  }
  return decoded as jwt.JwtPayload & { id: string };
}
