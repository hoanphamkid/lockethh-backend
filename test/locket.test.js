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

test('personal memories use the authenticated UID and the cursor returned by Locket', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(String(url).endsWith('/getLatestMomentV2'));
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    const data = JSON.parse(options.body).data;
    calls.push(data);
    assert.deepEqual(data.users, ['real-locket-user']);
    if (calls.length === 1) return json({ result: { status: 200, sync_token: 'server-cursor-1', data: [
      { canonical_uid: 'mine-new', user: 'real-locket-user', image_url: 'https://example.test/full-new.jpg', date: { seconds: 1731700000 } },
      { canonical_uid: 'friend-post', user: 'friend-a', thumbnail_url: 'https://example.test/friend.jpg', date: { _seconds: 1731700001 } },
      { canonical_uid: 'no-owner', thumbnail_url: 'https://example.test/unknown.jpg' },
    ] } });
    if (calls.length === 2) {
      assert.equal(data.sync_token, 'server-cursor-1');
      return json({ result: { status: 200, sync_token: 'server-cursor-2', data: [
        { canonical_uid: 'mine-old', user: 'real-locket-user', thumbnail_url: 'https://example.test/video.jpg', video_url: 'https://example.test/video.mp4', created_at: '1731600000' },
        { canonical_uid: 'mine-new', user: 'real-locket-user', image_url: 'https://example.test/full-new.jpg' },
        { canonical_uid: 'unreadable', user: 'real-locket-user', thumbnail_url: 'javascript:invalid' },
      ] } });
    }
    assert.equal(data.sync_token, 'server-cursor-2');
    return json({ result: { status: 304, data: [] } });
  });
  const memories = await locket.getMoments(credentials(), { ownOnly: true });
  assert.deepEqual(memories.map((item) => item.momentId), ['mine-new', 'mine-old']);
  assert.equal(memories[0].createdAt, '2024-11-15T19:46:40.000Z');
  assert.equal(memories[1].createdAt, '2024-11-14T16:00:00.000Z');
  assert.equal(memories[0].imageUrl, 'https://example.test/full-new.jpg');
  assert.equal(memories[1].videoUrl, 'https://example.test/video.mp4');
  assert.equal(calls.length, 3);
});

test('missing or invalid memory dates do not invent a month or epoch timestamp', async (t) => {
  let page = 0;
  t.mock.method(global, 'fetch', async () => json({ result: { data: page++ ? [] : [
    { canonical_uid: 'no-date', user: 'real-locket-user', date: null, thumbnail_url: 'https://example.test/a.jpg' },
    { canonical_uid: 'bad-date', user: 'real-locket-user', date: { _seconds: 'invalid' }, thumbnail_url: 'https://example.test/b.jpg' },
    { canonical_uid: 'bad-image', user: 'real-locket-user', thumbnail_url: 'bad-url', image_url: 'https://example.test/c.jpg' },
  ] } }));
  const memories = await locket.getMoments(credentials(), { ownOnly: true });
  assert.equal(memories.length, 3);
  assert.ok(memories.every((item) => item.createdAt === null));
  assert.equal(memories[2].thumbnailUrl, 'https://example.test/c.jpg');
});

test('malformed memory responses fail instead of becoming an empty gallery', async (t) => {
  t.mock.method(global, 'fetch', async () => json({ result: { status: 200, data: {} } }));
  await assert.rejects(locket.getMoments(credentials(), { ownOnly: true }), { status: 502 });
});

test('profile badge distinguishes Gold, hidden, and missing upstream data', async (t) => {
  let fields = { badge: 'locket_gold' };
  t.mock.method(global, 'fetch', async () => json({ result: { status: 200, data: fields } }));
  assert.equal((await locket.getProfile(credentials())).badge, 'locket_gold');
  fields = { badge: null };
  assert.equal((await locket.getProfile(credentials())).badge, null);
  fields = {};
  assert.equal((await locket.getProfile(credentials())).badge, undefined);
});

test('Gold badge updates persist to Locket and must be confirmed by a fresh profile read', async (t) => {
  let savedBadge = null;
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/changeProfileInfo')) {
      assert.deepEqual(Object.keys(body.data), ['badge']);
      savedBadge = body.data.badge;
      return json({ result: { status: 200 } });
    }
    assert.ok(String(url).endsWith('/fetchUserV2'));
    assert.equal(body.data.user_uid, 'real-locket-user');
    return json({ result: { status: 200, data: { first_name: 'Owner', badge: savedBadge } } });
  });
  const enabled = await locket.updateProfile(credentials(), { badge: 'locket_gold', idToken: 'ignored' });
  assert.equal(enabled.badge, 'locket_gold');
  const disabled = await locket.updateProfile(credentials(), { badge: null });
  assert.equal(disabled.badge, null);
  assert.equal(calls.length, 4);
});

test('badge validation rejects unsupported values before any upstream request', async (t) => {
  let requested = false;
  t.mock.method(global, 'fetch', async () => { requested = true; throw new Error('must not send'); });
  for (const badge of [true, false, '', 'premium', {}, 1]) {
    await assert.rejects(locket.updateProfile(credentials(), { badge }), { status: 400 });
  }
  assert.equal(requested, false);
});

test('HTTP 200 cannot confirm a badge change when the profile still has the old or unknown badge', async (t) => {
  let returnedBadge = null;
  let writes = 0;
  t.mock.method(global, 'fetch', async (url) => {
    if (String(url).endsWith('/changeProfileInfo')) { writes += 1; return json({ result: { status: 200 } }); }
    return json({ result: { status: 200, data: returnedBadge === undefined ? {} : { badge: returnedBadge } } });
  });
  await assert.rejects(locket.updateProfile(credentials(), { badge: 'locket_gold' }), { status: 409 });
  returnedBadge = undefined;
  await assert.rejects(locket.updateProfile(credentials(), { badge: null }), { status: 409 });
  assert.equal(writes, 2, 'Never retry profile writes automatically');
});

test('Locket refusals and App Check errors never produce a successful badge update', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls += 1;
    return json({ result: { status: 403, errors: ['App Check required'] } });
  });
  await assert.rejects(locket.updateProfile(credentials(), { badge: 'locket_gold' }), { status: 502 });
  assert.equal(calls, 1);
});

test('friends follow every Firestore page and keep missing profiles unnamed', async (t) => {
  let pages = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'firestore.googleapis.com') {
      pages += 1;
      assert.equal(options.headers.Authorization, 'Bearer access-token');
      if (!target.searchParams.has('pageToken')) return json({ documents: [{ name: 'users/owner/friends/friend-a' }], nextPageToken: 'next/page' });
      assert.equal(target.searchParams.get('pageToken'), 'next/page');
      return json({ documents: [{ name: 'users/owner/friends/friend-b' }] });
    }
    const uid = JSON.parse(options.body).data.user_uid;
    return uid === 'friend-a' ? json({ result: { data: { first_name: 'An', username: 'an' } } }) : json({ result: { data: {} } });
  });
  const friends = await locket.getFriends(credentials());
  assert.equal(pages, 2);
  assert.equal(friends.length, 2);
  assert.equal(friends[0].displayName, 'An');
  assert.equal(friends[1].uid, 'friend-b');
  assert.equal(friends[1].displayName, null);
});

test('an empty real friends collection remains empty', async (t) => {
  t.mock.method(global, 'fetch', async () => json({}));
  assert.deepEqual(await locket.getFriends(credentials()), []);
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
  t.mock.method(locket, 'getProfile', async () => ({ uid: 'real-locket-user', displayName: 'Tên từ Locket', username: 'real-owner', avatarUrl: 'https://example.test/avatar.jpg' }));
  t.mock.method(locket, 'updateProfile', async () => ({ uid: 'real-locket-user', displayName: 'Tên mới từ Locket', username: 'real-owner' }));
  t.mock.method(locket, 'getMoments', async (session, options) => {
    assert.equal(session.uid, 'real-locket-user');
    assert.deepEqual(options, { ownOnly: true });
    return [{ momentId: 'owned-memory', userUid: session.uid, imageUrl: 'https://example.test/memory.jpg' }];
  });
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
  const guestMemories = await originalFetch(`${base}/social/memories`);
  assert.equal(guestMemories.status, 401);

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
  const memoriesResponse = await originalFetch(`${base}/social/memories?uid=someone-else`, { headers: { Cookie: cookie } });
  assert.equal(memoriesResponse.status, 200);
  assert.equal((await memoriesResponse.json()).data[0].userUid, 'real-locket-user');
  const profile = await originalFetch(`${base}/auth/profile`, { headers: { Cookie: cookie } });
  assert.equal((await profile.json()).data.username, 'real-owner');
  const refreshedSession = await originalFetch(`${base}/auth/session`, { headers: { Cookie: cookie } });
  const refreshedUser = (await refreshedSession.json()).user;
  assert.equal(refreshedUser.displayName, 'Tên từ Locket');
  assert.equal(refreshedUser.avatarUrl, 'https://example.test/avatar.jpg');
  assert.equal('idToken' in refreshedUser, false);
  await originalFetch(`${base}/auth/profile`, { method: 'PATCH', headers: { ...clientHeaders, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ first_name: 'Tên mới' }) });
  const updatedSession = await originalFetch(`${base}/auth/session`, { headers: { Cookie: cookie } });
  assert.equal((await updatedSession.json()).user.displayName, 'Tên mới từ Locket');

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

test('upload size limits return clear Vietnamese errors and never publish rejected files', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = { 'X-Locket-Client': 'studio', 'Content-Type': 'application/json' };
  t.mock.method(locket, 'login', async () => ({ ...credentials(), uid: 'size-limit-user' }));
  let published = 0;
  t.mock.method(locket, 'upload', async () => { published += 1; return { momentId: 'accepted-at-limit' }; });
  const login = await originalFetch(`${base}/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'limits@example.test', password: 'secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (form) => originalFetch(`${base}/upload`, { method: 'POST', headers: { 'X-Locket-Client': 'studio', Cookie: cookie }, body: form });
  for (const [field, size, message] of [
    ['image', 5 * 1024 * 1024 + 1, /Ảnh.*5 MB/],
    ['image', 11 * 1024 * 1024, /Ảnh.*5 MB/],
    ['video', 10 * 1024 * 1024 + 1, /Video.*10 MB/],
  ]) {
    const form = new FormData();
    form.append(field, new Blob([Buffer.alloc(size)], { type: field === 'image' ? 'image/jpeg' : 'video/mp4' }), field === 'image' ? 'large.jpg' : 'large.mp4');
    const result = await post(form);
    assert.equal(result.status, 413);
    const body = await result.json();
    assert.equal(body.success, false);
    assert.match(body.message, message);
  }
  assert.equal(published, 0);
  const boundary = new FormData();
  boundary.append('image', new Blob([Buffer.alloc(5 * 1024 * 1024)], { type: 'image/jpeg' }), 'boundary.jpg');
  boundary.append('video', new Blob([Buffer.alloc(10 * 1024 * 1024)], { type: 'video/mp4' }), 'boundary.mp4');
  const accepted = await post(boundary);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(published, 1);
});
