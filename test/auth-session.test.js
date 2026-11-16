const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const locket = require('../src/services/locket.service');
const app = require('../src/app');
const originalFetch = global.fetch;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const credentials = () => ({ uid: 'session-owner', email: 'owner@example.test', displayName: 'Owner', idToken: 'old-access', refreshToken: 'valid-refresh', tokenExpiresAt: Date.now() + 3600000 });

async function client(t, values = credentials()) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.mock.method(locket, 'login', async () => values);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await originalFetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'X-Locket-Client': 'studio', 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'owner@example.test', password: 'test-only' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { base, cookie, get: (path) => originalFetch(`${base}${path}`, { headers: { Cookie: cookie } }) };
}

test('parallel permission failures after login do not delete the session or require another login', async (t) => {
  let refreshes = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('securetoken.googleapis.com')) { refreshes += 1; throw new Error('must not refresh for access denial'); }
    if (target.includes('/fetchUserV2')) {
      const uid = JSON.parse(options.body).data.user_uid;
      if (uid === 'session-owner') return json({ result: { status: 200, data: { first_name: 'Owner' } } });
      return json({ result: { status: 401, errors: ["You don't have access to this user"] } });
    }
    if (target.includes('/friends')) return json({ documents: [{ name: 'users/session-owner/friends/private-friend' }] });
    if (target.includes('/getLatestMomentV2')) return json({ result: { status: 401, errors: ['User does not have access to this moment'] } });
    return json({ error: { status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }, 403);
  });
  const api = await client(t);
  const [profile, friends, memories, conversations] = await Promise.all([
    api.get('/auth/profile'), api.get('/friends'), api.get('/social/memories'), api.get('/social/conversations'),
  ]);
  assert.equal(profile.status, 200);
  assert.equal(friends.status, 200);
  assert.equal((await friends.json()).data[0].displayName, null);
  for (const response of [memories, conversations]) {
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.json();
    assert.equal(body.code, 'LOCKET_PERMISSION_DENIED');
    assert.equal(body.requiresLogin, false);
  }
  assert.equal(refreshes, 0);
  assert.equal((await (await api.get('/auth/session')).json()).user.uid, 'session-owner');
});

test('an unclassified upstream HTTP 401 does not revoke an otherwise valid login', async (t) => {
  t.mock.method(global, 'fetch', async () => json({ result: { status: 401, errors: ['Resource unavailable'] } }));
  const api = await client(t);
  const response = await api.get('/auth/profile');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).requiresLogin, false);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await (await api.get('/auth/session')).json()).user.uid, 'session-owner');
});

test('a token rejected before its local expiry is refreshed once and the cookie session survives', async (t) => {
  let reads = 0;
  let refreshes = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).includes('securetoken.googleapis.com')) {
      refreshes += 1;
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'valid-refresh');
      return json({ id_token: 'fresh-access', refresh_token: 'fresh-refresh', user_id: 'session-owner', expires_in: '3600' });
    }
    reads += 1;
    if (options.headers.Authorization === 'Bearer old-access') return json({ result: { status: 401, errors: ['Please sign in'] } });
    assert.equal(options.headers.Authorization, 'Bearer fresh-access');
    return json({ result: { status: 200, data: { first_name: 'Owner' } } });
  });
  const api = await client(t);
  assert.equal((await api.get('/auth/profile')).status, 200);
  assert.equal(refreshes, 1);
  assert.equal(reads, 2);
  assert.equal((await (await api.get('/auth/session')).json()).user.uid, 'session-owner');
});

test('only a confirmed expired or revoked session invalidates the stored session and requests login', async (t) => {
  let refreshes = 0;
  t.mock.method(global, 'fetch', async (url) => {
    assert.ok(String(url).includes('securetoken.googleapis.com'));
    refreshes += 1;
    return json({ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400);
  });
  const api = await client(t, { ...credentials(), tokenExpiresAt: 0 });
  const response = await api.get('/auth/profile');
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.code, 'SESSION_EXPIRED');
  assert.equal(body.requiresLogin, true);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(refreshes, 1);
  assert.equal((await (await api.get('/auth/session')).json()).user, null);
});

test('a late failure from an old login cannot erase the new login cookie', async (t) => {
  let releaseFailure;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  t.mock.method(locket, 'getProfile', async () => {
    readStarted();
    return new Promise((resolve, reject) => { releaseFailure = () => reject(Object.assign(new Error('Expired old session'), { status: 401, code: 'SESSION_EXPIRED' })); });
  });
  const api = await client(t);
  const oldRead = api.get('/auth/profile');
  await started;
  const newLogin = await originalFetch(`${api.base}/auth/login`, {
    method: 'POST', headers: { Cookie: api.cookie, 'X-Locket-Client': 'studio', 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'owner@example.test', password: 'test-only' }),
  });
  const newCookie = newLogin.headers.get('set-cookie').split(';')[0];
  assert.notEqual(newCookie, api.cookie);
  releaseFailure();
  const response = await oldRead;
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  const restored = await originalFetch(`${api.base}/auth/session`, { headers: { Cookie: newCookie } });
  assert.equal((await restored.json()).user.uid, 'session-owner');
});

test('a read that still rejects a refreshed token never loops or retries a write', async (t) => {
  let reads = 0;
  let refreshes = 0;
  t.mock.method(global, 'fetch', async (url) => {
    if (String(url).includes('securetoken.googleapis.com')) {
      refreshes += 1;
      return json({ id_token: 'fresh-access', refresh_token: 'fresh-refresh', user_id: 'session-owner', expires_in: '3600' });
    }
    reads += 1;
    return json({ result: { status: 401, errors: ['Please sign in'] } });
  });
  await assert.rejects(locket.getProfile(credentials()), { code: 'SESSION_EXPIRED', status: 401 });
  assert.equal(refreshes, 1);
  assert.equal(reads, 2);
});
