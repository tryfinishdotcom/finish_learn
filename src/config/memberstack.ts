import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

type Env = Record<string, string | undefined>;

// Matches Memberstack's own server SDK (@memberstack/admin 1.7.0, verifyToken):
// signing keys from Memberstack's published JWKS, issuer api.memberstack.com, `exp`
// required, audience = the Memberstack app id. The site's app id is the default; set
// MEMBERSTACK_APP_ID to override it.
const DEFAULT_JWKS_URI = 'http://member-jwt.s3-website-us-east-1.amazonaws.com/';
const ISSUER = 'https://api.memberstack.com';
const DEFAULT_APP_ID = 'app_cmde998dl011d0wx92d1xae1y';

export function memberstackConfig(env: Env): { jwksUri: string; issuer: string; audience: string } {
  return {
    jwksUri: env.MEMBERSTACK_JWKS_URL || DEFAULT_JWKS_URI,
    issuer: ISSUER,
    audience: env.MEMBERSTACK_APP_ID || DEFAULT_APP_ID,
  };
}

// One JWKS client per key source, created on first use.
const jwksClients = new Map<string, jwksRsa.JwksClient>();
function jwksClientFor(uri: string): jwksRsa.JwksClient {
  let client = jwksClients.get(uri);
  if (!client) {
    client = jwksRsa({
      jwksUri: uri,
      cache: true,
      cacheMaxAge: 600000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 5
    });
    jwksClients.set(uri, client);
  }
  return client;
}

export async function verifyMemberstackToken(token: string): Promise<jwt.JwtPayload & { id: string }> {
  const { jwksUri, issuer, audience } = memberstackConfig(process.env);
  const client = jwksClientFor(jwksUri);
  const getKey: jwt.GetPublicKeyOrSecret = (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err) callback(err);
      else callback(null, key?.getPublicKey());
    });
  };

  const decoded = await new Promise<jwt.JwtPayload>((resolve, reject) => {
    jwt.verify(token, getKey, { algorithms: ['RS256'], issuer, audience }, (err, payload) => {
      if (err) reject(err);
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
  return decoded as jwt.JwtPayload & { id: string };
}

export function extractMemberId(token: string): string | null {
  try {
    const decoded = jwt.decode(token) as any;
    return decoded?.id || null;
  } catch {
    return null;
  }
}
