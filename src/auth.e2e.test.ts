// src/auth.e2e.test.ts
// Run with `npm run test:e2e`. Needs TEST_DATABASE_URL pointing at a throwaway Postgres
// database on localhost with the schema pushed (`DATABASE_URL=$TEST_DATABASE_URL npx
// prisma db push`). It refuses any other host and any database holding rows of
// learners other than `mem_e2e…` fixtures, and deletes only this run's own fixtures.
// Drives the real app (routes, controllers, Prisma) with RS256 tokens signed by a
// throwaway key served from a local JWKS endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import type { PrismaClient } from '@prisma/client';

const KID = 'e2e-key-1';
const APP_ID = 'app_cmde998dl011d0wx92d1xae1y';
const ISSUER = 'https://api.memberstack.com';
// Fixture learners are unique per run and the only rows this test ever deletes.
const FIXTURE_PREFIX = 'mem_e2e';
const RUN = crypto.randomBytes(6).toString('hex');
const A = `${FIXTURE_PREFIX}${RUN}A`;
const B = `${FIXTURE_PREFIX}${RUN}B`;
const signing = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const dbUrl = process.env.TEST_DATABASE_URL;
let jwksServer: http.Server;
let appServer: http.Server;
let base: string;
let prisma: PrismaClient;

function token(id: string, expiresIn = 3600): string {
  return jwt.sign({ id, type: 'member' }, signing.privateKey, {
    algorithm: 'RS256', keyid: KID, issuer: ISSUER, audience: APP_ID, expiresIn,
  });
}

async function call(method: string, path: string, bearer?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const lesson = (slug: string, pct: number) => ({
  lessonSlug: slug, courseSlug: 'course-1', secondsWatched: pct, totalDuration: 100,
  percentComplete: pct, url: `/lektion/${slug}`, title: slug, index: '1',
});

async function rowsFor(memberId: string) {
  const [lessons, courses, todos, last] = await Promise.all([
    prisma.lessonProgress.findMany({ where: { memberId }, orderBy: { lessonSlug: 'asc' } }),
    prisma.courseProgress.findMany({ where: { memberId } }),
    prisma.lessonTodo.findMany({ where: { memberId }, orderBy: { todoId: 'asc' } }),
    prisma.userLastLesson.findUnique({ where: { memberId } }),
  ]);
  return { lessons, courses, todos, last };
}

async function totalRows() {
  const counts = await Promise.all([
    prisma.lessonProgress.count(), prisma.courseProgress.count(),
    prisma.lessonTodo.count(), prisma.userLastLesson.count(),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

before(async () => {
  if (!dbUrl) return;
  const host = new URL(dbUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`refusing TEST_DATABASE_URL on ${host}: local throwaway databases only`);
  }
  const jwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  jwksServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = dbUrl;
  process.env.MEMBERSTACK_JWKS_URL = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/`;
  process.env.RATE_LIMIT_MAX_REQUESTS = '1000';
  delete process.env.SKIP_AUTH;
  delete process.env.AUTH_MEMBER_ID_FALLBACK_UNTIL;
  delete process.env.MEMBERSTACK_APP_ID;
  delete process.env.SENTRY_DSN;

  ({ prisma } = await import('./config/database'));
  const foreign = { NOT: { memberId: { startsWith: FIXTURE_PREFIX } } };
  const foreignRows = (await Promise.all([
    prisma.lessonProgress.count({ where: foreign }), prisma.courseProgress.count({ where: foreign }),
    prisma.lessonTodo.count({ where: foreign }), prisma.userLastLesson.count({ where: foreign }),
  ])).reduce((a, b) => a + b, 0);
  if (foreignRows > 0) throw new Error(`refusing: TEST_DATABASE_URL holds ${foreignRows} rows of other learners`);
  const { createApp } = await import('./app');
  appServer = http.createServer(createApp());
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  console.log = () => {};
});

after(async () => {
  for (const server of [appServer, jwksServer]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  if (prisma && appServer) {
    const ours = { memberId: { in: [A, B] } };
    await prisma.$transaction([
      prisma.lessonTodo.deleteMany({ where: ours }), prisma.lessonProgress.deleteMany({ where: ours }),
      prisma.courseProgress.deleteMany({ where: ours }), prisma.userLastLesson.deleteMany({ where: ours }),
    ]);
  }
  await prisma?.$disconnect();
});

const e2e = { skip: dbUrl ? false : 'TEST_DATABASE_URL not set' };

test('learner A saves and reads progress and todos; only A changes', e2e, async () => {
  // B has existing progress that must stay untouched.
  assert.equal((await call('POST', '/progress/lesson', token(B), lesson('lesson-b', 40))).status, 200);
  const bBefore = await rowsFor(B);

  const a = token(A);
  assert.equal((await call('POST', '/progress/lesson', a, lesson('lesson-a', 30))).status, 200);
  assert.equal((await call('PUT', '/todos/course/course-1', a, { todos: { 'lesson-a': { t1: true } } })).status, 200);

  const sync = await call('GET', '/sync/all', a);
  assert.equal(sync.status, 200);
  const dump = JSON.stringify(sync.json);
  assert.match(dump, /lesson-a/);
  assert.doesNotMatch(dump, /lesson-b/);
  assert.equal((await call('GET', '/activity/stats', a)).status, 200);

  const aRows = await rowsFor(A);
  assert.equal(aRows.lessons.length, 1);
  assert.equal(aRows.lessons[0].percentComplete, 30);
  assert.equal(aRows.todos.length, 1);
  assert.deepEqual(await rowsFor(B), bBefore);
});

test('A token plus B named in header, body or query: scoped to A, B unchanged', e2e, async () => {
  const bBefore = await rowsFor(B);
  const a = token(A);
  const spoof = { 'X-Member-ID': B };

  const write = await call('POST', `/progress/lesson?memberId=${B}&userId=${B}`, a,
    { ...lesson('lesson-b', 99), memberId: B, userId: B }, spoof);
  assert.equal(write.status, 200);
  const todos = await call('PUT', `/todos/course/course-1?memberId=${B}`, a,
    { todos: { 'lesson-b': { t9: true } }, memberId: B }, spoof);
  assert.equal(todos.status, 200);

  const read = await call('GET', `/sync/all?memberId=${B}&userId=${B}`, a, undefined, spoof);
  assert.equal(read.status, 200);
  // A now has a lesson-b row of its own at 99 %; B's stays at 40 %.
  assert.deepEqual(await rowsFor(B), bBefore);
  const aRows = await rowsFor(A);
  assert.equal(aRows.lessons.find((l) => l.lessonSlug === 'lesson-b')?.percentComplete, 99);
  assert.ok(aRows.todos.some((t) => t.todoId === 't9'));
});

test('no, malformed, fabricated, expired or foreign tokens: 401, nothing read or written', e2e, async () => {
  const before = await totalRows();
  const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const badTokens: Array<[string, Record<string, string>]> = [
    ['none', {}],
    ['malformed', { Authorization: 'Bearer not.a.jwt' }],
    ['member id', { Authorization: `Bearer ${B}`, 'X-Member-ID': B }],
    ['fabricated member id', { Authorization: `Bearer ${FIXTURE_PREFIX}${crypto.randomUUID().replace(/-/g, '')}` }],
    ['expired', { Authorization: `Bearer ${token(B, -60)}` }],
    ['wrong app', { Authorization: `Bearer ${jwt.sign({ id: B }, signing.privateKey, { algorithm: 'RS256', keyid: KID, issuer: ISSUER, audience: 'app_other', expiresIn: 3600 })}` }],
    ['foreign key', { Authorization: `Bearer ${jwt.sign({ id: B }, foreign.privateKey, { algorithm: 'RS256', keyid: KID, issuer: ISSUER, audience: APP_ID, expiresIn: 3600 })}` }],
  ];
  for (const [name, headers] of badTokens) {
    for (const [method, path, body] of [
      ['GET', '/sync/all', undefined],
      ['GET', '/activity/stats', undefined],
      ['GET', '/progress/lessons', undefined],
      ['POST', '/progress/lesson', lesson('lesson-x', 77)],
      ['PUT', '/todos/course/course-1', { todos: { 'lesson-x': { tx: true } } }],
    ] as const) {
      const res = await call(method, path, undefined, body, headers);
      assert.equal(res.status, 401, `${name} ${method} ${path}`);
      assert.equal(res.json?.data, undefined, `${name} ${method} ${path} returned data`);
    }
  }
  assert.equal(await totalRows(), before);
});
