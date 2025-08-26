import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

const MEMBERSTACK_API_URL = 'https://api.memberstack.com';

// Create JWKS client for Memberstack
const jwksClient = jwksRsa({
  jwksUri: `${MEMBERSTACK_API_URL}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 600000, // 10 minutes
  rateLimit: true,
  jwksRequestsPerMinute: 5
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  jwksClient.getSigningKey(header.kid!, (err, key) => {
    if (err) {
      callback(err);
    } else {
      const signingKey = key?.getPublicKey();
      callback(null, signingKey);
    }
  });
}

export async function verifyMemberstackToken(token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, {
      algorithms: ['RS256'],
      issuer: MEMBERSTACK_API_URL,
      audience: `app_${process.env.MEMBERSTACK_PUBLIC_KEY?.split('_')[1]}`
    }, (err, decoded) => {
      if (err) {
        reject(err);
      } else {
        resolve(decoded);
      }
    });
  });
}

export function extractMemberId(token: string): string | null {
  try {
    const decoded = jwt.decode(token) as any;
    return decoded?.id || null;
  } catch {
    return null;
  }
}
