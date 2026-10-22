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
let jwksUrl: string;
const authLines: string[] = [];
const realLog = console.log;

before(async () => {
  const jwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  jwksServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));

  process.env.NODE_ENV = 'test';
  delete process.env.SKIP_AUTH;
  delete process.env.MEMBERSTACK_APP_ID;
  delete process.env.AUTH_ALLOW_MEMBER_ID_FALLBACK;
  delete process.env.RAILWAY_ENVIRONMENT;
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/`;
  process.env.MEMBERSTACK_JWKS_URL = jwksUrl;

  const auth = await import('./middleware/auth');
  const { authenticateUser } = auth;
  describeAuthMode = auth.describeAuthMode;
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
const ENV_KEYS = ['NODE_ENV', 'SKIP_AUTH', 'AUTH_ALLOW_MEMBER_ID_FALLBACK', 'RAILWAY_ENVIRONMENT', 'MEMBERSTACK_JWKS_URL'];
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
  opts: { key?: crypto.KeyObject; audience?: string; issuer?: string; exp?: boolean; expiresIn?: number } = {}
): string {
  return jwt.sign(claims, opts.key ?? signing.privateKey, {
    algorithm: 'RS256',
    keyid: KID,
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

test('with AUTH_ALLOW_MEMBER_ID_FALLBACK=true a member id is admitted, during the cutover only', async () => {
  process.env.AUTH_ALLOW_MEMBER_ID_FALLBACK = 'true';
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

test('only the exact value true turns the fallback on', async () => {
  for (const value of ['1', 'TRUE', 'yes', ' true', '']) {
    process.env.AUTH_ALLOW_MEMBER_ID_FALLBACK = value;
    assert.equal((await me('mem_fallback3')).status, 401, JSON.stringify(value));
  }
});

test('SKIP_AUTH in production does not bypass verification', async () => {
  process.env.NODE_ENV = 'production';
  process.env.SKIP_AUTH = 'true';
  const { status } = await me('mem_skipauth1', { 'X-Member-ID': 'mem_skipauth1' });
  assert.equal(status, 401);
});

test('NODE_ENV=development on a Railway deployment does not bypass verification', async () => {
  process.env.NODE_ENV = 'development';
  process.env.RAILWAY_ENVIRONMENT = 'production';
  const { status } = await me('mem_railwaydev1');
  assert.equal(status, 401);
});

test('local development still takes the member id from the request', async () => {
  process.env.NODE_ENV = 'development';
  const { status, body } = await me('mem_local1', { 'X-Member-ID': 'mem_local2' });
  assert.equal(status, 200);
  assert.equal(body.userId, 'mem_local2');
});

test('an unreachable key source answers 503, not 401, and admits nobody', async () => {
  process.env.MEMBERSTACK_JWKS_URL = 'http://127.0.0.1:9/';
  process.env.AUTH_ALLOW_MEMBER_ID_FALLBACK = 'true';
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

test('the startup line names the active mode', () => {
  assert.equal(describeAuthMode({ NODE_ENV: 'production' }), '[auth] mode=verified_token member_id_fallback=off');
  assert.equal(
    describeAuthMode({ NODE_ENV: 'production', AUTH_ALLOW_MEMBER_ID_FALLBACK: 'true' }),
    '[auth] mode=verified_token member_id_fallback=on'
  );
  assert.equal(
    describeAuthMode({ NODE_ENV: 'development', RAILWAY_ENVIRONMENT: 'production', SKIP_AUTH: 'true' }),
    '[auth] mode=verified_token member_id_fallback=off'
  );
  assert.match(describeAuthMode({ NODE_ENV: 'development' }), /development_bypass/);
});

test('a request without a token is rejected', async () => {
  const { status } = await me();
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('the counter line never carries the token or the member id', async () => {
  process.env.AUTH_ALLOW_MEMBER_ID_FALLBACK = 'true';
  await me(sign({ id: 'mem_secretish' }));
  await me('mem_secretish');
  assert.equal(authLines.length, 2);
  for (const line of authLines) assert.doesNotMatch(line, /mem_|eyJ/);
});

test('config defaults to the documented key source and the app id as audience', () => {
  assert.deepEqual(memberstackConfig({}), {
    jwksUri: 'http://member-jwt.s3-website-us-east-1.amazonaws.com/',
    issuer: 'https://api.memberstack.com',
    audience: 'app_cmde998dl011d0wx92d1xae1y',
  });
  assert.equal(memberstackConfig({ MEMBERSTACK_APP_ID: 'app_other' }).audience, 'app_other');
  // The old audience source must not leak back in.
  assert.equal(memberstackConfig({ MEMBERSTACK_PUBLIC_KEY: 'pk_abc_def' }).audience, APP_ID);
});
