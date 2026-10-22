// src/client-patch.test.ts
// Runs the shipped Webflow footer patch (client/webflow-footer-auth-patch.html) in a
// simulated browser: shared localStorage (all tabs of one browser), a stub Memberstack
// session and a stub backend that records whose token carried which save. Synthetic
// learner ids only; no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PATCH = fs
  .readFileSync(path.join(__dirname, '..', 'client', 'webflow-footer-auth-patch.html'), 'utf8')
  .replace(/^[\s\S]*?<script>/, '')
  .replace(/<\/script>[\s\S]*$/, '');

const A = 'mem_testA';
const B = 'mem_testB';

type Sent = { method: string; path: string; tokenOwner: string | null; body: any };
type Reply = { status: number } | Promise<{ status: number }>;

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick();
}

function tokenOwner(token: string | undefined): string | null {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).id;
  } catch {
    return null;
  }
}

// One browser: localStorage shared by its tabs, one Memberstack session, one backend.
function makeBrowser() {
  const proto = {
    getItem(this: any, k: string) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; },
    setItem(this: any, k: string, v: string) { this[k] = String(v); },
    removeItem(this: any, k: string) { delete this[k]; },
  };
  const localStorage: any = Object.create(proto);
  let version = 0;
  const valid = new Set<string>();
  const sent: Sent[] = [];
  const server: Record<string, Record<string, any>> = {};
  let nextReply: ((req: Sent) => Reply) | null = null;
  let renewOnCheck = false;

  function issue(id: string): string {
    const token = 'h.' + Buffer.from(JSON.stringify({ id, v: ++version })).toString('base64url') + '.s';
    valid.add(token);
    return token;
  }
  function signIn(id: string): void {
    localStorage.setItem('_ms-mem', JSON.stringify({ id }));
    localStorage.setItem('_ms-mid', issue(id));
  }
  function signOut(): void {
    localStorage.removeItem('_ms-mem');
    localStorage.removeItem('_ms-mid');
  }

  async function fetch(url: string, opts: any) {
    const auth: string = opts.headers.Authorization;
    const token = auth.replace(/^Bearer /, '');
    const req: Sent = {
      method: opts.method || 'GET',
      path: url.replace('https://test.invalid/api', ''),
      tokenOwner: tokenOwner(token),
      body: opts.body ? JSON.parse(opts.body) : null,
    };
    sent.push(req);
    const custom = nextReply;
    nextReply = null;
    const reply = custom ? await custom(req) : { status: valid.has(token) ? 200 : 401 };
    if (reply.status === 200 && req.method !== 'GET' && req.tokenOwner) {
      (server[req.tokenOwner] ||= {})[req.path] = req.body;
    }
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => ({ data: {} }) };
  }

  // A tab: its own window/page, the browser's shared storage, session and backend.
  function openTab() {
    const authListeners: Array<(m: any) => void> = [];
    const storageListeners: Array<(e: any) => void> = [];
    const tab = { reloads: 0, modals: [] as string[], api: null as any, signInHere, signOutHere, otherTabChanged };
    const $memberstackDom = {
      getMemberCookie: () => localStorage.getItem('_ms-mid'),
      onAuthChange: (cb: (m: any) => void) => authListeners.push(cb),
      getCurrentMember: async () => {
        const member = JSON.parse(localStorage.getItem('_ms-mem') || 'null');
        if (member && renewOnCheck) localStorage.setItem('_ms-mid', issue(member.id));
        // Memberstack reports nobody signed in once the session cannot be renewed.
        return { data: member && valid.has(localStorage.getItem('_ms-mid')) ? member : null };
      },
      openModal: (name: string) => tab.modals.push(name),
    };
    // Stand-in for the live LearningPlatformAPI: the patch replaces its request path.
    class LearningPlatformAPI {
      baseURL = 'https://test.invalid/api';
      token: string | null = null;
      memberId: string | null = null;
    }
    const window: any = {
      $memberstackDom,
      location: { reload: () => { tab.reloads++; } },
      addEventListener: (type: string, cb: (e: any) => void) => { if (type === 'storage') storageListeners.push(cb); },
    };
    window.learningAPI = new LearningPlatformAPI();
    const ctx = vm.createContext({
      window,
      localStorage,
      document: { cookie: '' },
      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      fetch,
      Promise,
      console,
    });
    vm.runInContext(PATCH, ctx);
    tab.api = window.learningAPI;
    function signInHere(id: string) { signIn(id); authListeners.forEach((cb) => cb({ data: { id } })); }
    function signOutHere() { signOut(); authListeners.forEach((cb) => cb({ data: null })); }
    // Another tab of this browser changed the session: this tab gets a storage event.
    function otherTabChanged() { storageListeners.forEach((cb) => cb({ key: '_ms-mem' })); }
    return tab;
  }

  return {
    localStorage, sent, server, valid, signIn, signOut, openTab,
    replyOnce(fn: (req: Sent) => Reply) { nextReply = fn; },
    renewOnCheck(on: boolean) { renewOnCheck = on; },
    pending(id: string): Record<string, any> {
      return JSON.parse(localStorage.getItem('learningAPI:pending:' + id) || '{}');
    },
  };
}

const progress = (api: any, lessonSlug: string, percentComplete: number) =>
  api.request('/progress/lesson', { method: 'POST', body: JSON.stringify({ lessonSlug, percentComplete }) });
const todos = (api: any, course: string, state: Record<string, any>) =>
  api.request('/todos/course/' + course, { method: 'PUT', body: JSON.stringify({ todos: state }) });
const read = (api: any) => api.request('/sync/all');
const sentBy = (sent: Sent[], id: string) => sent.filter((r) => r.tokenOwner === id);

test('(a) account switch right after a save is made: nothing is sent under the new learner', async () => {
  const br = makeBrowser();
  br.signIn(A);
  const tab = br.openTab();
  const p1 = progress(tab.api, 'a-lesson', 80).catch((e: Error) => e.message);
  const p2 = todos(tab.api, 'a-course', { 'a-lesson': { t1: true } }).catch((e: Error) => e.message);
  br.signIn(B); // another tab signs in as B before the queued sends run
  assert.deepEqual(await Promise.all([p1, p2]), ['Account changed', 'Account changed']);
  await settle();
  assert.equal(br.sent.length, 0, 'no request at all');
  assert.deepEqual(Object.keys(br.pending(A)).sort(), ['POST /progress/lesson a-lesson', 'PUT /todos/course/a-course']);
  assert.deepEqual(br.pending(B), {}, 'nothing queued for B');
  assert.equal(tab.reloads, 1, 'page starts over for B');
});

test('(b) account switch while an earlier save is still in flight', async () => {
  const br = makeBrowser();
  br.signIn(A);
  const tab = br.openTab();
  let release!: (r: { status: number }) => void;
  br.replyOnce(() => new Promise((resolve) => { release = resolve; }));
  const first = progress(tab.api, 'a-lesson', 40).catch((e: Error) => e.message);
  await settle(); // first save is on the wire with A's token
  const second = progress(tab.api, 'a-lesson', 90).catch((e: Error) => e.message);
  const third = todos(tab.api, 'a-course', { 'a-lesson': { t1: true } }).catch((e: Error) => e.message);
  br.signIn(B);
  tab.otherTabChanged();
  release({ status: 200 });
  await Promise.all([first, second, third]);
  await settle();
  assert.deepEqual(br.sent.map((r) => r.tokenOwner), [A], 'only the save already sent, with A');
  assert.equal(sentBy(br.sent, B).length, 0);
  assert.equal(br.pending(A)['POST /progress/lesson a-lesson'].body, JSON.stringify({ lessonSlug: 'a-lesson', percentComplete: 90 }));
  assert.ok(br.pending(A)['PUT /todos/course/a-course']);
  assert.deepEqual(br.pending(B), {});
  assert.ok(tab.reloads >= 1);
});

test('(b2) a 401 answered after the switch is not retried with the new learner\'s token', async () => {
  const br = makeBrowser();
  br.signIn(A);
  const tab = br.openTab();
  br.renewOnCheck(true); // getCurrentMember would hand out a fresh token, now B's
  let release!: (r: { status: number }) => void;
  br.replyOnce(() => new Promise((resolve) => { release = resolve; }));
  const first = todos(tab.api, 'a-course', { 'a-lesson': { t1: true } }).catch((e: Error) => e.message);
  await settle();
  br.signIn(B);
  release({ status: 401 });
  assert.equal(await first, 'API Error: 401');
  await settle();
  assert.equal(sentBy(br.sent, B).length, 0);
  assert.ok(br.pending(A)['PUT /todos/course/a-course']);
});

test('(c) sign-out, then B signs in on the same page: A\'s saves never go out under B', async () => {
  const br = makeBrowser();
  br.signIn(A);
  br.localStorage.setItem('progressByLesson', JSON.stringify({ 'a-lesson': { percent: 50 } }));
  br.localStorage.setItem('todos:course:a-course', JSON.stringify({ 'a-lesson': { t1: true } }));
  const tab = br.openTab();
  br.signOut(); // in another tab
  assert.equal(await progress(tab.api, 'a-lesson', 60).catch((e: Error) => e.message), 'No authentication');
  assert.equal(await todos(tab.api, 'a-course', { 'a-lesson': { t2: true } }).catch((e: Error) => e.message), 'No authentication');
  await settle();
  assert.deepEqual(tab.modals, ['LOGIN']);
  tab.signInHere(B);
  assert.equal(tab.reloads, 1, 'B gets a fresh page');
  // Anything the old page still does before the reload lands stays with A.
  assert.equal(await progress(tab.api, 'a-lesson', 70).catch((e: Error) => e.message), 'Account changed');
  await settle();
  assert.equal(br.sent.length, 0);

  const page2 = br.openTab(); // the reload: same browser storage, B signed in
  assert.equal(br.localStorage.getItem('progressByLesson'), null, 'A\'s page store is not shown to B');
  assert.equal(br.localStorage.getItem('todos:course:a-course'), null);
  await progress(page2.api, 'b-lesson', 10);
  await todos(page2.api, 'b-course', { 'b-lesson': { t1: true } });
  await settle();
  assert.equal(sentBy(br.sent, A).length, 0);
  assert.deepEqual(sentBy(br.sent, B).map((r) => r.body), [
    { lessonSlug: 'b-lesson', percentComplete: 10 },
    { todos: { 'b-lesson': { t1: true } } },
  ]);
  assert.deepEqual(Object.keys(br.pending(A)).sort(), ['POST /progress/lesson a-lesson', 'PUT /todos/course/a-course']);
  assert.equal(JSON.parse(br.pending(A)['POST /progress/lesson a-lesson'].body).percentComplete, 70);
});

test('(d) A signs in again: A\'s kept saves are delivered with A\'s session only', async () => {
  const br = makeBrowser();
  br.signIn(A);
  const tab = br.openTab();
  br.signOut();
  await progress(tab.api, 'a-lesson', 60).catch(() => {});
  await todos(tab.api, 'a-course', { 'a-lesson': { t1: true } }).catch(() => {});
  // B used the browser in between and left a queue of their own.
  br.signIn(B);
  const bPage = br.openTab();
  br.valid.clear(); // B's session dies: B's save stays queued under B
  await progress(bPage.api, 'b-lesson', 30).catch(() => {});
  br.signOut();

  tab.signInHere(A); // A signs in again on the original page: same learner, no reload
  assert.equal(tab.reloads, 0);
  await read(tab.api);
  await settle();
  const fromA = sentBy(br.sent, A);
  assert.deepEqual(fromA.map((r) => r.method + ' ' + r.path), ['GET /sync/all', 'POST /progress/lesson', 'PUT /todos/course/a-course']);
  assert.deepEqual(br.server[A]['/progress/lesson'], { lessonSlug: 'a-lesson', percentComplete: 60 });
  assert.deepEqual(br.server[A]['/todos/course/a-course'], { todos: { 'a-lesson': { t1: true } } });
  assert.deepEqual(br.pending(A), {});
  assert.ok(br.pending(B)['POST /progress/lesson b-lesson'], 'B\'s queue untouched');
  assert.equal(br.server[A]['/progress/lesson b-lesson'], undefined);
});

test('(e) normal saves of a signed-in learner work, and a renewed session is used once', async () => {
  const br = makeBrowser();
  br.signIn(A);
  const tab = br.openTab();
  await progress(tab.api, 'a-lesson', 25);
  await todos(tab.api, 'a-course', { 'a-lesson': { t1: true } });
  assert.deepEqual(br.sent.map((r) => r.tokenOwner), [A, A]);
  assert.deepEqual(br.server[A]['/progress/lesson'], { lessonSlug: 'a-lesson', percentComplete: 25 });

  // Session renewed by Memberstack while the page held the old token: three saves at
  // once, each gets 401 once, each retries with A's fresh token, no login prompt.
  br.valid.clear();
  br.renewOnCheck(true);
  await Promise.all([
    progress(tab.api, 'a-lesson', 50),
    todos(tab.api, 'a-course', { 'a-lesson': { t1: true, t2: true } }),
    read(tab.api),
  ]);
  assert.equal(tab.api.authExpired, undefined);
  assert.deepEqual(tab.modals, []);
  assert.deepEqual(br.server[A]['/progress/lesson'], { lessonSlug: 'a-lesson', percentComplete: 50 });
  assert.deepEqual(br.pending(A), {});
  assert.equal(tab.reloads, 0);
  assert.equal(sentBy(br.sent, B).length, 0);
});

test('(e2) expired session: save kept, login offered, delivered after A signs in again', async () => {
  const br = makeBrowser();
  br.signIn(A);
  const tab = br.openTab();
  br.valid.clear(); // no renewal available
  assert.equal(await progress(tab.api, 'a-lesson', 35).catch((e: Error) => e.message), 'API Error: 401');
  await settle();
  assert.equal(tab.api.authExpired, true);
  assert.deepEqual(tab.modals, ['LOGIN']);
  assert.ok(br.pending(A)['POST /progress/lesson a-lesson']);
  tab.signInHere(A);
  await todos(tab.api, 'a-course', { 'a-lesson': { t1: true } });
  await settle();
  assert.deepEqual(br.server[A]['/progress/lesson'], { lessonSlug: 'a-lesson', percentComplete: 35 });
  assert.deepEqual(br.pending(A), {});
});

test('a page opened for B sets A\'s store aside; A gets it back on the next visit', async () => {
  const br = makeBrowser();
  br.signIn(A);
  br.openTab();
  const aStore: Record<string, string> = {
    progressByLesson: JSON.stringify({ 'a-lesson': { percent: 50 } }),
    courseProgress: '{"a-course":{}}',
    lastLesson: '{"lessonSlug":"a-lesson"}',
    'todos:course:a-course': '{"a-lesson":{"t1":true}}',
  };
  for (const [k, v] of Object.entries(aStore)) br.localStorage.setItem(k, v);
  br.signIn(B);
  br.openTab();
  for (const k of Object.keys(aStore)) assert.equal(br.localStorage.getItem(k), null, k);
  assert.equal(br.localStorage.getItem('learningAPI:storeOwner'), B);
  br.localStorage.setItem('progressByLesson', '{"b-lesson":{"percent":5}}');
  br.signIn(B);
  br.openTab();
  assert.equal(br.localStorage.getItem('progressByLesson'), '{"b-lesson":{"percent":5}}', 'same learner: store kept');
  br.signIn(A);
  br.openTab();
  for (const [k, v] of Object.entries(aStore)) assert.equal(br.localStorage.getItem(k), v, k);
  assert.equal(br.localStorage.getItem('learningAPI:store:' + A), null);
  assert.ok(br.localStorage.getItem('learningAPI:store:' + B), 'B\'s store set aside in turn');
});

test('a page opened signed out: its own learner signs in without reload, anyone else gets a fresh page', async () => {
  const br = makeBrowser();
  br.signIn(A);
  br.openTab(); // labels the store for A
  br.signOut();
  const tab = br.openTab();
  tab.signInHere(A);
  assert.equal(tab.reloads, 0);
  await progress(tab.api, 'a-lesson', 20);
  assert.deepEqual(br.sent.map((r) => r.tokenOwner), [A]);

  br.signOut();
  const other = br.openTab();
  other.signInHere(B);
  assert.equal(other.reloads, 1);
  assert.equal(await progress(other.api, 'a-lesson', 30).catch((e: Error) => e.message), 'Account changed');
  await settle();
  assert.deepEqual(br.sent.map((r) => r.tokenOwner), [A]);
});
