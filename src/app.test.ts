// src/app.test.ts
// Run with `npm test`. Uses node:test and real HTTP requests against the Express app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { AddressInfo } from 'node:net';
import express from 'express';
import * as Sentry from '@sentry/node';
import type { Express } from 'express';

// Captured Sentry error events. beforeSend returns null, so nothing leaves the process.
const sentryEvents: Sentry.Event[] = [];

let createApp: () => Express;
let errorHandler: express.ErrorRequestHandler;

before(async () => {
  // The rate limiter reads its limits when its module loads, so set them before importing.
  process.env.RATE_LIMIT_MAX_REQUESTS = '2';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  delete process.env.SENTRY_DSN;
  process.env.NODE_ENV = 'test';

  Sentry.init({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    defaultIntegrations: false,
    beforeSend(event) {
      sentryEvents.push(event);
      return null;
    },
  });

  ({ createApp } = await import('./app'));
  ({ errorHandler } = await import('./middleware/errorHandler'));
});

after(async () => {
  await Sentry.close(100);
});

async function listen(app: Express): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function capturedAfterFlush(): Promise<Sentry.Event[]> {
  await Sentry.flush(500);
  return sentryEvents.splice(0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a request the client aborts mid-body keeps a 4xx status and is not reported to Sentry', async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  let serverRes: http.ServerResponse | undefined;
  server.on('request', (_req, res) => {
    serverRes = res;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'POST /api/progress/lesson HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/json\r\n' +
            'X-Forwarded-For: 198.51.100.10, 152.233.12.241\r\n' +
            'Content-Length: 1000\r\n' +
            '\r\n' +
            '{"lessonSlug":"intro","sec',
          () => {
            // Give the server a moment to start reading the body, then hang up like a
            // browser that navigates away while lesson progress is saving.
            setTimeout(() => {
              socket.destroy();
              resolve();
            }, 50);
          }
        );
      });
      socket.on('error', reject);
    });

    await sleep(300);
    assert.ok(serverRes, 'the server saw the request');
    assert.equal(serverRes.statusCode, 400);
    assert.deepEqual(await capturedAfterFlush(), []);
  } finally {
    await close(server);
  }
});

test('a malformed JSON body answers 400 and is not reported to Sentry', async () => {
  const { server, port } = await listen(createApp());
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/progress/lesson`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.11, 152.233.12.241',
      },
      body: '{"lessonSlug":',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; message?: string };
    assert.notEqual(body.error, 'Internal server error');
    assert.deepEqual(await capturedAfterFlush(), []);
  } finally {
    await close(server);
  }
});

test('errorHandler answers with err.status for 4xx errors and does not report them', async () => {
  const app = express();
  app.get('/teapot', (_req, _res, next) => {
    next(Object.assign(new Error('Payload too large'), { status: 413, expose: true }));
  });
  app.use(errorHandler);
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teapot`);
    assert.equal(res.status, 413);
    assert.deepEqual(await capturedAfterFlush(), []);
  } finally {
    await close(server);
  }
});

test('errorHandler still answers 500 and reports unexpected errors to Sentry', async () => {
  const app = express();
  app.get('/boom', (_req, _res, next) => {
    next(new Error('database exploded'));
  });
  app.get('/boom-503', (_req, _res, next) => {
    next(Object.assign(new Error('upstream down'), { statusCode: 503 }));
  });
  app.use(errorHandler);
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; message?: string };
    assert.equal(body.error, 'Internal server error');
    assert.equal(body.message, undefined, 'internal error details stay hidden outside development');

    const res503 = await fetch(`http://127.0.0.1:${port}/boom-503`);
    assert.equal(res503.status, 503);

    const events = await capturedAfterFlush();
    assert.deepEqual(
      events.map((e) => e.exception?.values?.[0]?.value),
      ['database exploded', 'upstream down']
    );
  } finally {
    await close(server);
  }
});

test('two clients behind the Railway proxy chain get separate rate-limit buckets', async () => {
  // Production X-Forwarded-For on Railway is "<client>, <CDN edge>"; the socket peer is
  // Railway's edge proxy. Both clients below arrive through the same CDN edge address.
  const { server, port } = await listen(createApp());
  const hit = (xff: string) =>
    fetch(`http://127.0.0.1:${port}/api/does-not-exist`, { headers: { 'X-Forwarded-For': xff } });
  try {
    const clientA = '198.51.100.21, 152.233.12.241';
    const clientB = '198.51.100.22, 152.233.12.241';

    assert.equal((await hit(clientA)).status, 404);
    assert.equal((await hit(clientA)).status, 404);
    assert.equal((await hit(clientA)).status, 429, 'client A used up its own bucket of 2');

    const b = await hit(clientB);
    assert.equal(b.status, 404, 'client B is not throttled by client A');
    assert.equal(b.headers.get('ratelimit-remaining'), '1');
  } finally {
    await close(server);
  }
});

test('a single-entry X-Forwarded-For (no CDN hop) still keys on the client', async () => {
  const { server, port } = await listen(createApp());
  const hit = (xff: string) =>
    fetch(`http://127.0.0.1:${port}/api/does-not-exist`, { headers: { 'X-Forwarded-For': xff } });
  try {
    assert.equal((await hit('198.51.100.31')).status, 404);
    assert.equal((await hit('198.51.100.31')).status, 404);
    assert.equal((await hit('198.51.100.31')).status, 429);
    assert.equal((await hit('198.51.100.32')).status, 404);
  } finally {
    await close(server);
  }
});
