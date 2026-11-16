const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { once } = require('node:events');
const locket = require('../src/services/locket.service');
const app = require('../src/app');
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; });

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const image = () => sharp({ create: { width: 40, height: 20, channels: 3, background: '#fbc51b' } }).png().toBuffer();
const credentials = () => ({ uid: 'real-locket-user', email: 'owner@example.test', displayName: 'Owner', idToken: 'access-token', refreshToken: 'refresh-token', tokenExpiresAt: Date.now() + 3600000 });

function mockUpload(t, momentBody = { result: { status: 200, data: { canonical_uid: 'confirmed-moment' } } }) {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('uploadType=resumable')) return json({}, 200, { 'x-goog-upload-url': 'https://firebasestorage.googleapis.com/upload-session' });
    if (options.method === 'PUT') return json({});
    if (String(url).includes('/postMomentV2')) return json(momentBody);
    return json({ downloadTokens: 'image-download-token' });
  });
  return calls;
}

test('login sends credentials only to Locket auth and rejects an invalid password', async (t) => {
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'identitytoolkit.googleapis.com');
    assert.equal(new URL(url).pathname, '/v1/accounts:signInWithPassword');
    const data = JSON.parse(options.body);
    assert.equal(data.email, 'owner@example.test');
    assert.equal(data.password, 'secret');
    return json({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, 400);
  });
  await assert.rejects(locket.login('owner@example.test', 'secret'), { status: 401 });
});

test('phone login exchanges the custom token and obtains UID from the authenticated Google account', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(String(url));
    const body = JSON.parse(options.body);
    if (String(url).includes('signInWithPhonePassword')) {
      assert.equal(body.data.phone, '+84901234567');
      assert.equal(body.data.password, 'secret');
      assert.equal(body.data.analytics.platform, 'ios');
      return json({ result: { status: 200, token: 'custom-token' } });
    }
    if (String(url).includes('verifyCustomToken')) {
      assert.equal(body.token, 'custom-token');
      return json({ idToken: 'phone-access', refreshToken: 'phone-refresh', expiresIn: '3600' });
    }
    assert.equal(body.idToken, 'phone-access');
    return json({ users: [{ localId: 'phone-user', phoneNumber: '+84901234567' }] });
  });
  const session = await locket.login('+84901234567', 'secret');
  assert.equal(calls.length, 3);
  assert.equal(session.uid, 'phone-user');
  assert.equal(session.phoneNumber, '+84901234567');
  assert.equal(session.idToken, 'phone-access');
});

test('wrong phone credentials inside HTTP 200 never create a session', async (t) => {
  t.mock.method(global, 'fetch', async () => json({ result: { status: 400 } }));
  await assert.rejects(locket.login('+84901234567', 'wrong-password'), { status: 401 });
});

test('profile lookup returns safe account fields without credentials', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    assert.match(String(url), /fetchUserV2/);
    return json({ result: { data: {
      username: 'jessicafam', first_name: 'Sünk', last_name: 'Ak',
      created_at: '2023-05-22T03:08:23Z', updated_at: '2026-09-30T12:47:49Z',
      email_verified: true,
    } } });
  });
  const profile = await locket.getProfile(credentials());
  assert.equal(profile.uid, 'real-locket-user');
  assert.equal(profile.username, 'jessicafam');
  assert.equal(profile.email, 'owner@example.test');
  assert.equal(profile.emailVerified, true);
  assert.equal('idToken' in profile, false);
  assert.equal('refreshToken' in profile, false);
});

test('moment feed returns normalized real media URLs and caption overlays', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    assert.match(String(url), /getLatestMomentV2/);
    return json({ result: { data: [{ canonical_uid: 'moment-1', user: 'real-locket-user', thumbnail_url: 'https://firebasestorage.googleapis.com/thumb', date: { _seconds: 1731700000 }, overlays: [{ alt_text: 'Hello Locket' }] }] } });
  });
  const moments = await locket.getMoments(credentials());
  assert.deepEqual(moments, [{ momentId: 'moment-1', userUid: 'real-locket-user', thumbnailUrl: 'https://firebasestorage.googleapis.com/thumb', imageUrl: 'https://firebasestorage.googleapis.com/thumb', videoUrl: null, caption: 'Hello Locket', createdAt: '2024-11-15T19:46:40.000Z', date: { _seconds: 1731700000 } }]);
});

test('upload transforms image, uses the real UID, broadcasts caption and requires confirmation', async (t) => {
  const calls = mockUpload(t);
  const result = await locket.upload(credentials(), await image(), '  Xin chào  ');
  assert.equal(result.momentId, 'confirmed-moment');
  assert.equal(calls.length, 4);
  const start = JSON.parse(calls[0].options.body);
  assert.match(start.name, /^users\/real-locket-user\/moments\/thumbnails\/[a-z0-9]{20}\.webp$/);
  assert.equal(calls[0].options.headers.Authorization, 'Firebase access-token');
  assert.equal(calls[0].options.headers['X-Firebase-Storage-Version'], 'ios/12.12.1');
  const uploaded = await sharp(calls[1].options.body).metadata();
  assert.equal(uploaded.format, 'webp');
  assert.equal(uploaded.width, 1020);
  assert.equal(uploaded.height, 1020);
  const post = JSON.parse(calls[3].options.body).data;
  assert.equal(calls[3].options.headers.Authorization, 'Bearer access-token');
  assert.equal(post.sent_to_self_only, false);
  assert.equal(post.sent_to_all, true);
  assert.deepEqual(post.recipients, []);
  assert.equal(post.overlays[0].data.text, 'Xin chào');
  assert.equal(post.overlays[0].alt_text, 'Xin chào');
  assert.deepEqual(post.overlays[0].data.max_lines, { '@type': 'type.googleapis.com/google.protobuf.Int64Value', value: '4' });
  assert.equal(post.overlays[0].data.background.material_blur, 'regular');
  assert.deepEqual(post.overlays[0].data.background.colors, ['#FFC107', '#FFE082']);
  assert.equal(post.overlays[0].data.text_color, '#4A3000E6');
  assert.equal(post.analytics.platform, 'ios');
  assert.match(post.analytics.installation_id, /^[a-f0-9]{22}$/);
  assert.match(post.md5, /^[a-f0-9]{32}_\d+$/);
  assert.match(post.thumbnail_url, /token=image-download-token/);
});

test('private audience posts only to the account owner', async (t) => {
  const calls = mockUpload(t);
  await locket.upload(credentials(), await image(), '', { mode: 'private', excludedIds: [] });
  const post = JSON.parse(calls.at(-1).options.body).data;
  assert.equal(post.sent_to_self_only, true);
  assert.equal(post.sent_to_all, false);
  assert.deepEqual(post.recipients, []);
});

test('video upload sends a confirmed video_url alongside its thumbnail', async (t) => {
  const calls = mockUpload(t);
  await locket.upload(credentials(), await image(), 'Video test', { mode: 'all' }, Buffer.from('video-bytes'), 'video/mp4', 'blue');
  const post = JSON.parse(calls.at(-1).options.body).data;
  assert.match(post.video_url, /firebasestorage\.googleapis\.com/);
  assert.match(post.thumbnail_url, /token=image-download-token/);
  assert.deepEqual(post.overlays[0].data.background.colors, ['#3298FF', '#8DD8FF']);
});

test('exclude audience resolves friends and sends only to the remaining UIDs', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/documents/users/real-locket-user/friends')) {
      return json({ documents: [{ name: 'projects/locket-4252/databases/(default)/documents/users/real-locket-user/friends/friend-a' }, { name: 'projects/locket-4252/databases/(default)/documents/users/real-locket-user/friends/friend-b' }] });
    }
    if (String(url).includes('/fetchUserV2')) return json({ result: { data: { first_name: 'Friend' } } });
    if (String(url).includes('uploadType=resumable')) return json({}, 200, { 'x-goog-upload-url': 'https://firebasestorage.googleapis.com/upload-session' });
    if (options.method === 'PUT') return json({ downloadTokens: 'image-download-token' });
    if (String(url).includes('/postMomentV2')) return json({ result: { data: { canonical_uid: 'confirmed-moment' } } });
    return json({ downloadTokens: 'image-download-token' });
  });
  await locket.upload(credentials(), await image(), '', { mode: 'exclude', excludedIds: ['friend-a'] });
  const post = JSON.parse(calls.at(-1).options.body).data;
  assert.equal(post.sent_to_self_only, false);
  assert.equal(post.sent_to_all, false);
  assert.deepEqual(post.recipients, ['friend-b']);
});

test('an HTTP 200 without a moment ID never counts as a published image', async (t) => {
  mockUpload(t, { result: { status: 200 } });
  await assert.rejects(locket.upload(credentials(), await image()), /chưa xác nhận bài đăng/);
});

test('Locket errors inside HTTP 200 fail the upload', async (t) => {
  mockUpload(t, { result: { status: 403, errors: ['Permission denied'] } });
  await assert.rejects(locket.upload(credentials(), await image()), { status: 502 });
});

test('App Check refusals are reported without attempting a bypass', async (t) => {
  const calls = mockUpload(t, { result: { status: 403, errors: ['App Check token required'] } });
  await assert.rejects(locket.upload(credentials(), await image()), /App Check/);
  assert.equal(calls.length, 4);
});

test('expired access tokens refresh before storage and rotated credentials stay on the session', async (t) => {
  const session = credentials();
  session.tokenExpiresAt = 0;
  const calls = mockUpload(t);
  const uploadFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('securetoken.googleapis.com')) {
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'refresh-token');
      return json({ id_token: 'fresh-access', refresh_token: 'fresh-refresh', user_id: session.uid, expires_in: '3600' });
    }
    return uploadFetch(url, options);
  };
  await locket.upload(session, await image());
  assert.equal(session.refreshToken, 'fresh-refresh');
  assert.equal(calls[0].options.headers.Authorization, 'Firebase fresh-access');
  assert.equal(session.refreshing, undefined);
});

test('invalid image bytes are rejected before any network request', async (t) => {
  const fetch = t.mock.method(global, 'fetch', () => { throw new Error('Must not be called'); });
  await assert.rejects(locket.upload(credentials(), Buffer.from('<script>not an image</script>')), { status: 400 });
  assert.equal(fetch.mock.callCount(), 0);
});

test('untrusted storage destinations are rejected before sending image bytes', async (t) => {
  const fetch = t.mock.method(global, 'fetch', async () => json({}, 200, { 'x-goog-upload-url': 'https://other.example/upload' }));
  await assert.rejects(locket.upload(credentials(), await image()), /không được hỗ trợ/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('completed upload metadata provides the download token without an extra metadata request', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('uploadType=resumable')) return json({}, 200, { 'x-goog-upload-url': 'https://firebasestorage.googleapis.com/upload-session' });
    if (options.method === 'PUT') return json({ downloadTokens: ' final-token , unused-token ' });
    if (String(url).includes('postMomentV2')) {
      const data = JSON.parse(options.body).data;
      assert.match(data.thumbnail_url, /token=final-token$/);
      assert.deepEqual(data.overlays, []);
      return json({ result: { data: { canonical_uid: 'confirmed-moment' } } });
    }
    throw new Error('Unexpected metadata lookup');
  });
  await locket.upload(credentials(), await image());
  assert.equal(calls.length, 3);
});

test('missing download tokens fail without inventing a URL or creating a moment', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('uploadType=resumable')) return json({}, 200, { 'x-goog-upload-url': 'https://firebasestorage.googleapis.com/upload-session' });
    return json({});
  });
  await assert.rejects(locket.upload(credentials(), await image()), /chưa xác nhận ảnh/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => !url.includes('postMomentV2')));
});

test('network failure during posting rejects and never retries the write', async (t) => {
  const calls = mockUpload(t);
  const uploadFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('postMomentV2')) {
      calls.push({ url, options });
      throw new TypeError('Simulated network failure');
    }
    return uploadFetch(url, options);
  };
  await assert.rejects(locket.upload(credentials(), await image()), { status: 502 });
  assert.equal(calls.filter((call) => call.url.includes('postMomentV2')).length, 1);
});

test('a top-level HTTP 403 response cannot become a successful moment', async (t) => {
  mockUpload(t);
  const uploadFetch = global.fetch;
  global.fetch = (url, options) => String(url).includes('postMomentV2')
    ? Promise.resolve(json({ error: { status: 'PERMISSION_DENIED', message: 'Denied' } }, 403))
    : uploadFetch(url, options);
  await assert.rejects(locket.upload(credentials(), await image()), { status: 502 });
});

test('client metadata remains stable within a session and separate across accounts', async (t) => {
  const calls = mockUpload(t);
  const first = credentials();
  const second = { ...credentials(), uid: 'second-locket-user' };
  const png = await image();
  await locket.upload(first, png);
  await locket.upload(first, png);
  await locket.upload(second, png);
  const posts = calls.filter((call) => call.url.includes('postMomentV2')).map((call) => JSON.parse(call.options.body).data);
  assert.equal(posts[0].analytics.installation_id, posts[1].analytics.installation_id);
  assert.notEqual(posts[0].analytics.installation_id, posts[2].analytics.installation_id);
});

test('malformed inner error values still reject cleanly', async (t) => {
  mockUpload(t, { result: { status: 403, errors: 'App Check required' } });
  await assert.rejects(locket.upload(credentials(), await image()), { status: 502, message: 'Locket yêu cầu xác minh ứng dụng (App Check). Chưa thể đăng ảnh từ web.' });
});

test('HTTP routes enforce real sessions, protect credentials, upload multipart and invalidate logout', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const clientHeaders = { 'X-Locket-Client': 'studio' };
  let uploadCount = 0;
  t.mock.method(locket, 'login', async () => credentials());
  t.mock.method(locket, 'upload', async (session, buffer, caption, audience, video, videoType, captionStyle) => {
    uploadCount += 1;
    assert.equal(session.uid, 'real-locket-user');
    assert.ok(buffer.length > 0);
    assert.equal(caption, 'Caption');
    assert.equal(captionStyle, 'blue');
    return { momentId: 'http-confirmed-moment' };
  });

  const missingHeader = await originalFetch(`${base}/auth/login`, { method: 'POST' });
  assert.equal(missingHeader.status, 403);
  const unauthenticated = await originalFetch(`${base}/upload`, { method: 'POST', headers: clientHeaders });
  assert.equal(unauthenticated.status, 401);
  const fakeAuth = await originalFetch(`${base}/upload`, { method: 'POST', headers: { ...clientHeaders, Authorization: 'Bearer fake-token' } });
  assert.equal(fakeAuth.status, 401);

  const login = await originalFetch(`${base}/auth/login`, {
    method: 'POST', headers: { ...clientHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password: 'secret' }),
  });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Lax/);
  assert.ok(!cookieHeader.includes('access-token'));
  const cookie = cookieHeader.split(';')[0];
  const loginBody = await login.text();
  assert.ok(!/access-token|refresh-token|secret/.test(loginBody));
  const session = await originalFetch(`${base}/auth/session`, { headers: { Cookie: cookie } });
  assert.equal((await session.json()).user.uid, 'real-locket-user');

  const form = new FormData();
  form.append('image', new Blob([await image()], { type: 'image/png' }), 'photo.png');
  form.append('caption', 'Caption');
  form.append('captionStyle', 'blue');
  const post = await originalFetch(`${base}/upload`, { method: 'POST', headers: { ...clientHeaders, Cookie: cookie }, body: form });
  assert.equal(post.status, 200, await post.clone().text());
  assert.equal((await post.json()).data.momentId, 'http-confirmed-moment');
  assert.equal(uploadCount, 1);

  await originalFetch(`${base}/auth/logout`, { method: 'POST', headers: { ...clientHeaders, Cookie: cookie } });
  const revoked = await originalFetch(`${base}/upload`, { method: 'POST', headers: { ...clientHeaders, Cookie: cookie } });
  assert.equal(revoked.status, 401);
});
