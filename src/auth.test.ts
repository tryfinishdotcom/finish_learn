// src/auth.test.ts
// Run with `npm test`. Signs real RS256 tokens with a throwaway key pair and serves its
// public key from a local JWKS endpoint, so the verify path runs end to end.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

const KID = 'test-key-1';
const APP_ID = 'app_cmde998dl011d0wx92d1xae1y';
const ISSUER = 'https://api.memberstack.com';

const signing = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

let jwksServer: http.Server;
let appServer: http.Server;
let base: string;
let memberstackConfig: typeof import('./config/memberstack').memberstackConfig;
let describeAuthMode: typeof import('./middleware/auth').describeAuthMode;
let memberIdFallbackState: typeof import('./middleware/auth').memberIdFallbackState;
let jwksUrl: string;
let jwksHits = 0;
const authLines: string[] = [];
const realLog = console.log;
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

before(async () => {
  const jwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  jwksServer = http.createServer((_req, res) => {
    jwksHits++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));

  process.env.NODE_ENV = 'test';
  delete process.env.SKIP_AUTH;
  delete process.env.MEMBERSTACK_APP_ID;
  delete process.env.AUTH_MEMBER_ID_FALLBACK_UNTIL;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.AUTH_DEV_BYPASS;
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/`;
  process.env.MEMBERSTACK_JWKS_URL = jwksUrl;

  const auth = await import('./middleware/auth');
  const { authenticateUser } = auth;
  describeAuthMode = auth.describeAuthMode;
  memberIdFallbackState = auth.memberIdFallbackState;
  ({ memberstackConfig } = await import('./config/memberstack'));

  const app = express();
  app.get('/me', authenticateUser, (req, res) => {
    res.json({ userId: (req as { userId?: string }).userId });
  });
  appServer = http.createServer(app);
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('auth_path=')) authLines.push(line);
    else realLog(...args);
  };
});

// Env keys a test may change; each is put back after every test.
const ENV_KEYS = ['NODE_ENV', 'SKIP_AUTH', 'AUTH_DEV_BYPASS', 'AUTH_MEMBER_ID_FALLBACK_UNTIL', 'RAILWAY_ENVIRONMENT', 'MEMBERSTACK_JWKS_URL'];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  authLines.length = 0;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

after(async () => {
  console.log = realLog;
  appServer.closeAllConnections();
  jwksServer.closeAllConnections();
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => jwksServer.close(() => r()));
});

function sign(
  claims: Record<string, unknown>,
  opts: { key?: crypto.KeyObject; audience?: string; issuer?: string; exp?: boolean; expiresIn?: number; kid?: string } = {}
): string {
  return jwt.sign(claims, opts.key ?? signing.privateKey, {
    algorithm: 'RS256',
    keyid: opts.kid ?? KID,
    issuer: opts.issuer ?? ISSUER,
    audience: opts.audience ?? APP_ID,
    ...(opts.exp === false ? {} : { expiresIn: opts.expiresIn ?? 3600 }),
  });
}

async function me(token?: string, headers: Record<string, string> = {}) {
  return meRaw({ ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers });
}

async function meRaw(headers: Record<string, string>) {
  const res = await fetch(`${base}/me`, { headers });
  const body = (await res.json()) as { userId?: string; error?: string };
  return { status: res.status, body };
}

test('a correctly signed member token with the app id as audience passes', async () => {
  const { status, body } = await me(sign({ id: 'mem_signed1', type: 'member' }));
  assert.equal(status, 200);
  assert.equal(body.userId, 'mem_signed1');
  assert.deepEqual(authLines, ['[auth] auth_path=verified_jwt']);
});

test('a token for another app (wrong audience) is rejected', async () => {
  const { status } = await me(sign({ id: 'mem_signed2' }, { audience: 'app_someoneelse' }));
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('a token signed with another key is rejected', async () => {
  const { status } = await me(sign({ id: 'mem_signed3' }, { key: stranger.privateKey }));
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('a token from another issuer is rejected', async () => {
  const { status } = await me(sign({ id: 'mem_signed4' }, { issuer: 'https://example.com' }));
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('a token without an expiry is rejected', async () => {
  const { status } = await me(sign({ id: 'mem_signed5' }, { exp: false }));
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('a verified token without a member id is rejected', async () => {
  const { status } = await me(sign({ type: 'member' }));
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('an expired token is rejected', async () => {
  const { status } = await me(sign({ id: 'mem_signed6' }, { expiresIn: -60 }));
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('an HS256 token keyed with the public key is rejected', async () => {
  const pem = signing.publicKey.export({ format: 'pem', type: 'spki' }) as string;
  const token = jwt.sign({ id: 'mem_signed7' }, pem, {
    algorithm: 'HS256', keyid: KID, issuer: ISSUER, audience: APP_ID, expiresIn: 3600,
  });
  const { status } = await me(token);
  assert.equal(status, 401);
});

test('a token declaring a non-member type is rejected', async () => {
  const { status } = await me(sign({ id: 'mem_signed10', type: 'admin' }));
  assert.equal(status, 401);
});

test('made-up key ids are rejected without hammering the key source; real tokens keep working', async () => {
  assert.equal((await me(sign({ id: 'mem_warm' }))).status, 200);
  const hitsBefore = jwksHits;
  for (let i = 0; i < 20; i++) {
    const { status } = await me(sign({ id: 'mem_kid' }, { kid: crypto.randomUUID() }));
    assert.equal(status, 401);
  }
  assert.ok(jwksHits - hitsBefore <= 1, `key source fetched ${jwksHits - hitsBefore} times`);
  const { status, body } = await me(sign({ id: 'mem_afterflood' }));
  assert.equal(status, 200);
  assert.equal(body.userId, 'mem_afterflood');
});

test('a bare member id as token is rejected', async () => {
  const { status, body } = await me('mem_fallback1');
  assert.equal(status, 401);
  assert.equal(body.userId, undefined);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('a member id in X-Member-ID cannot pick the learner', async () => {
  const withMemberId = await me('mem_victim1', { 'X-Member-ID': 'mem_victim1' });
  assert.equal(withMemberId.status, 401);
  const verified = await me(sign({ id: 'mem_caller1' }), { 'X-Member-ID': 'mem_victim1' });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.userId, 'mem_caller1');
});

test('malformed Authorization headers are rejected', async () => {
  for (const authorization of ['Bearer', 'Bearer ', 'mem_raw1', 'Basic mem_raw1', 'Bearer mem_raw1 extra']) {
    const { status } = await meRaw({ Authorization: authorization });
    assert.equal(status, 401, authorization);
  }
});

test('until AUTH_MEMBER_ID_FALLBACK_UNTIL a member id is admitted, during the cutover only', async () => {
  process.env.AUTH_MEMBER_ID_FALLBACK_UNTIL = inHours(2);
  const { status, body } = await me('mem_fallback2');
  assert.equal(status, 200);
  assert.equal(body.userId, 'mem_fallback2');
  assert.deepEqual(authLines, ['[auth] auth_path=member_id_fallback']);
  // A verified token still names its own learner.
  const verified = await me(sign({ id: 'mem_signed8' }));
  assert.equal(verified.body.userId, 'mem_signed8');
  // Anything that is neither stays out.
  assert.equal((await me('not-a-member')).status, 401);
});

test('the fallback ends by itself and cannot be opened wide', async () => {
  for (const value of [inHours(-1), inHours(24 * 8), 'true', '1', '2026-13-01T00:00Z', 'tomorrow', '']) {
    process.env.AUTH_MEMBER_ID_FALLBACK_UNTIL = value;
    assert.equal((await me('mem_fallback3')).status, 401, JSON.stringify(value));
  }
  const now = Date.parse('2026-11-30T20:00:00Z');
  // Before the hard stop the window is capped at it, after it nothing opens.
  assert.deepEqual(memberIdFallbackState({ AUTH_MEMBER_ID_FALLBACK_UNTIL: '2026-12-02T00:00Z' }, now), { on: true, until: new Date('2026-11-30T23:59:59Z') });
  assert.deepEqual(memberIdFallbackState({ AUTH_MEMBER_ID_FALLBACK_UNTIL: '2026-12-02T00:00Z' }, Date.parse('2026-12-01T00:00:00Z')), { on: false, reason: 'expired' });
  assert.equal(memberIdFallbackState({ AUTH_MEMBER_ID_FALLBACK_UNTIL: '2026-11-25T00:00Z' }, Date.parse('2026-11-24T00:00:00Z')).on, true);
});

test('SKIP_AUTH in production does not bypass verification', async () => {
  process.env.NODE_ENV = 'production';
  process.env.SKIP_AUTH = 'true';
  const { status } = await me('mem_skipauth1', { 'X-Member-ID': 'mem_skipauth1' });
  assert.equal(status, 401);
});

test('NODE_ENV=development alone does not bypass verification', async () => {
  process.env.NODE_ENV = 'development';
  assert.equal((await me('mem_devonly1')).status, 401);
});

test('NODE_ENV=development with AUTH_DEV_BYPASS on a Railway deployment does not bypass verification', async () => {
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DEV_BYPASS = 'true';
  process.env.RAILWAY_ENVIRONMENT = 'production';
  const { status } = await me('mem_railwaydev1');
  assert.equal(status, 401);
});

test('local development with AUTH_DEV_BYPASS still takes the member id from the request', async () => {
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DEV_BYPASS = 'true';
  const { status, body } = await me('mem_local1', { 'X-Member-ID': 'mem_local2' });
  assert.equal(status, 200);
  assert.equal(body.userId, 'mem_local2');
});

test('an unreachable key source answers 503, not 401, and admits nobody', async () => {
  process.env.MEMBERSTACK_JWKS_URL = 'http://127.0.0.1:9/';
  process.env.AUTH_MEMBER_ID_FALLBACK_UNTIL = inHours(2);
  const realError = console.error;
  console.error = () => {};
  try {
    const { status, body } = await me(sign({ id: 'mem_signed9' }));
    assert.equal(status, 503);
    assert.equal(body.userId, undefined);
    assert.deepEqual(authLines, ['[auth] auth_path=key_source_unavailable']);
  } finally {
    console.error = realError;
  }
});

test('a key source override without HTTPS is refused (503), never trusted', async () => {
  process.env.MEMBERSTACK_JWKS_URL = 'http://member-jwt.s3-website-us-east-1.amazonaws.com/';
  const realError = console.error;
  console.error = () => {};
  try {
    const { status, body } = await me(sign({ id: 'mem_signed11' }));
    assert.equal(status, 503);
    assert.equal(body.userId, undefined);
  } finally {
    console.error = realError;
  }
});

test('the startup line names the active mode', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(describeAuthMode({ NODE_ENV: 'production' }, now), '[auth] mode=verified_token member_id_fallback=off (unset)');
  assert.equal(
    describeAuthMode({ NODE_ENV: 'production', AUTH_MEMBER_ID_FALLBACK_UNTIL: '2026-10-24T18:00Z' }, now),
    '[auth] mode=verified_token member_id_fallback=on until=2026-10-24T18:00:00.000Z'
  );
  assert.equal(
    describeAuthMode({ NODE_ENV: 'production', AUTH_MEMBER_ID_FALLBACK_UNTIL: 'true' }, now),
    '[auth] mode=verified_token member_id_fallback=off (invalid)'
  );
  assert.equal(
    describeAuthMode({ NODE_ENV: 'development', AUTH_DEV_BYPASS: 'true', RAILWAY_ENVIRONMENT: 'production', SKIP_AUTH: 'true' }, now),
    '[auth] mode=verified_token member_id_fallback=off (unset)'
  );
  assert.equal(describeAuthMode({ NODE_ENV: 'development' }, now), '[auth] mode=verified_token member_id_fallback=off (unset)');
  assert.match(describeAuthMode({ NODE_ENV: 'development', AUTH_DEV_BYPASS: 'true' }, now), /development_bypass/);
});

test('a request without a token is rejected', async () => {
  const { status } = await me();
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('the counter line never carries the token or the member id', async () => {
  process.env.AUTH_MEMBER_ID_FALLBACK_UNTIL = inHours(2);
  await me(sign({ id: 'mem_secretish' }));
  await me('mem_secretish');
  assert.equal(authLines.length, 2);
  for (const line of authLines) assert.doesNotMatch(line, /mem_|eyJ/);
});

test('config defaults to the documented key source and the app id as audience', () => {
  assert.deepEqual(memberstackConfig({}), {
    jwksUri: 'https://member-jwt.s3.amazonaws.com/jwks.json',
    issuer: 'https://api.memberstack.com',
    audience: 'app_cmde998dl011d0wx92d1xae1y',
  });
  assert.equal(memberstackConfig({ MEMBERSTACK_APP_ID: 'app_other' }).audience, 'app_other');
  // The old audience source must not leak back in.
  assert.equal(memberstackConfig({ MEMBERSTACK_PUBLIC_KEY: 'pk_abc_def' }).audience, APP_ID);
});

