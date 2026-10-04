// src/auth.test.ts
// Run with `npm test`. Signs real RS256 tokens with a throwaway key pair and serves its
// public key from a local JWKS endpoint, so the verify path runs end to end.
import { test, before, after, afterEach } from 'node:test';
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
  process.env.MEMBERSTACK_JWKS_URL = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/`;

  const { authenticateUser } = await import('./middleware/auth');
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

afterEach(() => {
  authLines.length = 0;
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
  opts: { key?: crypto.KeyObject; audience?: string; issuer?: string; exp?: boolean } = {}
): string {
  return jwt.sign(claims, opts.key ?? signing.privateKey, {
    algorithm: 'RS256',
    keyid: KID,
    issuer: opts.issuer ?? ISSUER,
    audience: opts.audience ?? APP_ID,
    ...(opts.exp === false ? {} : { expiresIn: '1h' }),
  });
}

async function me(token?: string) {
  const res = await fetch(`${base}/me`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
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

test('while the fallback exists, a member id as token is still admitted', async () => {
  const { status, body } = await me('mem_fallback1');
  assert.equal(status, 200);
  assert.equal(body.userId, 'mem_fallback1');
  assert.deepEqual(authLines, ['[auth] auth_path=member_id_fallback']);
});

test('a request without a token is rejected', async () => {
  const { status } = await me();
  assert.equal(status, 401);
  assert.deepEqual(authLines, ['[auth] auth_path=rejected']);
});

test('the counter line never carries the token or the member id', async () => {
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
