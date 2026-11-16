const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const deviceProfile = require('./locket-device');
const ffmpegPath = require('ffmpeg-static');

// Photo upload/auth flow adapted from leanhminh2104/locketlam 1.0.2.
// See THIRD_PARTY_NOTICES.md. This module runs entirely in Node.js.

// Public mobile-client configuration; these are not user credentials.
const API_KEY = process.env.LOCKET_FIREBASE_API_KEY || 'AIzaSyCQngaaXQIfJaH0aS2l7REgIjD7nL431So';
const BUCKET = process.env.LOCKET_STORAGE_BUCKET || 'locket-img';

function failure(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function convertWebmToMp4(video) {
  if (!ffmpegPath) throw failure('Máy chủ chưa có bộ chuyển đổi video để đăng video quay từ trình duyệt.', 503);
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1',
  ], { input: video, maxBuffer: 50 * 1024 * 1024, timeout: 120000, windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout?.length) {
    throw failure('Không thể chuyển video quay từ trình duyệt sang MP4 để đăng lên Locket.', 400);
  }
  return result.stdout;
}

function upstreamError(response, body, stage) {
  const errors = body?.result?.errors;
  const code = [
    typeof body?.error === 'string' ? body.error : body?.error?.message,
    body?.error?.status,
    ...(Array.isArray(errors) ? errors : [errors]),
  ].filter((value) => typeof value === 'string').join(' ');
  if (/INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS/.test(code)) {
    return failure('Thông tin đăng nhập Locket không đúng.', 401);
  }
  if (/TOO_MANY_ATTEMPTS/.test(code) || response.status === 429) {
    return failure('Có quá nhiều yêu cầu. Vui lòng đợi một lát rồi thử lại.', 429);
  }
  if (/USER_DISABLED/.test(code)) return failure('Tài khoản Locket đã bị vô hiệu hóa.', 401);
  if (/APP.?CHECK|attestation/i.test(code)) {
    return failure('Locket yêu cầu xác minh ứng dụng (App Check). Chưa thể đăng ảnh từ web.');
  }
  if (stage === 'đăng nhập' && body?.result && response.status === 400) {
    return failure('Số điện thoại hoặc mật khẩu Locket không đúng.', 401);
  }
  if (response.status === 401 || /TOKEN_EXPIRED|INVALID_ID_TOKEN|INVALID_REFRESH_TOKEN|USER_NOT_FOUND|UNAUTHENTICATED/.test(code)) {
    return failure('Phiên Locket đã hết hạn. Hãy đăng nhập lại.', 401);
  }
  return failure(`Locket từ chối ${stage} (HTTP ${response.status}). Vui lòng thử lại hoặc dùng ứng dụng Locket.`);
}

async function request(url, options, stage) {
  let response;
  let body;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
    try { body = await response.json(); }
    catch (error) {
      if (error.name !== 'SyntaxError') throw error;
      body = null; // Upload-session responses may have no JSON body.
    }
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw failure(`Locket phản hồi quá lâu khi ${stage}. Kiểm tra ứng dụng trước khi gửi lại để tránh trùng bài.`, 504);
    }
    throw failure(`Không kết nối được Locket khi ${stage}. Kiểm tra mạng rồi thử lại.`);
  }
  if (!response.ok || body?.error) throw upstreamError(response, body, stage);
  const errors = body?.result?.errors;
  if ((Array.isArray(errors) ? errors.length > 0 : Boolean(errors)) || Number(body?.result?.status) >= 400) {
    throw upstreamError({ status: Number(body.result.status) || 502 }, body, stage);
  }
  return { response, body };
}

function jsonOptions(body, headers = {}, device = deviceProfile.createDevice()) {
  return { method: 'POST', headers: { ...deviceProfile.headers(device), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

async function login(identifier, password) {
  const isPhone = !identifier.includes('@');
  const device = deviceProfile.createDevice();
  let body;
  if (isPhone) {
    const { body: phone } = await request('https://api.locketcamera.com/signInWithPhonePassword',
      jsonOptions({ data: { phone: identifier, password, analytics: deviceProfile.analytics(device) } }, {}, device), 'đăng nhập');
    if (phone?.result?.status !== 200 || !phone.result.token) throw failure('Locket không trả về phiên đăng nhập hợp lệ.');
    ({ body } = await request(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyCustomToken?key=${API_KEY}`,
      jsonOptions({ token: phone.result.token, returnSecureToken: true }, {}, device), 'đăng nhập',
    ));
    if (!body?.idToken) throw failure('Locket không trả về phiên đăng nhập hợp lệ.');
    const { body: account } = await request(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${API_KEY}`,
      jsonOptions({ idToken: body.idToken }, {}, device), 'đọc tài khoản',
    );
    body = { ...body, ...account?.users?.[0] };
  } else {
    ({ body } = await request(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
      jsonOptions({ email: identifier, password, returnSecureToken: true }, {}, device), 'đăng nhập',
    ));
  }
  if (!body?.localId || !body.idToken || !body.refreshToken || !Number.isFinite(Number(body.expiresIn)) || Number(body.expiresIn) <= 0) {
    throw failure('Locket không trả về phiên đăng nhập hợp lệ.');
  }
  return {
    uid: body.localId, email: body.email || null, phoneNumber: body.phoneNumber || (isPhone ? identifier : null),
    displayName: body.displayName || body.email || identifier,
    idToken: body.idToken, refreshToken: body.refreshToken,
    device,
    tokenExpiresAt: Date.now() + Number(body.expiresIn) * 1000,
  };
}

async function getAccessToken(session) {
  if (session.tokenExpiresAt > Date.now() + 60000) return session.idToken;
  // Share concurrent refreshes so requests cannot overwrite a rotated token.
  if (!session.refreshing) {
    session.refreshing = (async () => {
      const { body } = await request(
        `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { ...deviceProfile.headers(deviceProfile.getDevice(session)), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
        }, 'làm mới phiên',
      );
      if (!body?.id_token || !body.refresh_token || body.user_id !== session.uid || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 0) {
        throw failure('Phiên Locket không hợp lệ. Hãy đăng nhập lại.', 401);
      }
      session.idToken = body.id_token;
      session.refreshToken = body.refresh_token;
      session.tokenExpiresAt = Date.now() + Number(body.expires_in) * 1000;
      return session.idToken;
    })().finally(() => { delete session.refreshing; });
  }
  return session.refreshing;
}

function unwrapResult(body) {
  return body?.result?.data ?? body?.result ?? body?.data ?? body ?? {};
}

function normalizeFriendProfile(body, uid) {
  const profile = unwrapResult(body);
  const firstName = profile.first_name || profile.firstName || '';
  const lastName = profile.last_name || profile.lastName || '';
  const displayName = profile.display_name || profile.displayName || [firstName, lastName].filter(Boolean).join(' ')
    || profile.username || null;
  return {
    uid,
    displayName,
    username: profile.username || null,
    avatarUrl: profile.profile_picture_url || profile.profilePictureUrl || profile.photo_url || null,
    // Missing is unknown; explicit null means the badge is hidden.
    badge: profile.badge === 'locket_gold' || profile.badge === null ? profile.badge : undefined,
  };
}

async function getProfile(session) {
  const idToken = await getAccessToken(session);
  const device = deviceProfile.getDevice(session);
  const profileResponse = await request('https://api.locketcamera.com/fetchUserV2', jsonOptions({ data: { user_uid: session.uid } }, { Authorization: `Bearer ${idToken}` }, device), 'đọc hồ sơ tài khoản');
  const profile = unwrapResult(profileResponse.body);
  const normalized = normalizeFriendProfile(profileResponse.body, session.uid);
  return {
    ...normalized,
    email: session.email || null,
    phoneNumber: session.phoneNumber || null,
    birthdate: profile.birthdate || profile.birth_date || null,
    createdAt: profile.created_at || profile.createdAt || profile.createdAtTimestamp || null,
    updatedAt: profile.updated_at || profile.updatedAt || profile.last_updated_at || null,
    emailVerified: profile.email_verified ?? profile.emailVerified ?? null,
  };
}

async function updateProfile(session, updates = {}) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw failure('Thông tin hồ sơ không hợp lệ.', 400);
  const allowed = ['first_name', 'last_name', 'birthdate'];
  const patch = Object.fromEntries(allowed.filter((key) => typeof updates[key] === 'string' && updates[key].trim()).map((key) => [key, updates[key].trim()]));
  const changingBadge = Object.hasOwn(updates, 'badge');
  if (changingBadge) {
    if (updates.badge !== null && updates.badge !== 'locket_gold') throw failure('Huy hiệu không hợp lệ.', 400);
    patch.badge = updates.badge;
  }
  if (!Object.keys(patch).length) throw failure('Thông tin hồ sơ không hợp lệ.', 400);
  const idToken = await getAccessToken(session);
  const device = deviceProfile.getDevice(session);
  await request('https://api.locketcamera.com/changeProfileInfo', jsonOptions({ data: patch }, { Authorization: `Bearer ${idToken}` }, device), 'cập nhật hồ sơ Locket');
  const profile = await getProfile(session);
  if (changingBadge && profile.badge !== patch.badge) {
    throw failure('Locket chưa xác nhận thay đổi huy hiệu. Hãy làm mới hồ sơ trước khi thử lại.', 409);
  }
  return profile;
}

async function getFriends(session) {
  const idToken = await getAccessToken(session);
  const device = deviceProfile.getDevice(session);
  const url = `https://firestore.googleapis.com/v1/projects/locket-4252a/databases/(default)/documents/users/${encodeURIComponent(session.uid)}/friends?pageSize=300`;
  const documents = await listFirestoreDocuments(url, idToken, device, 'đọc danh sách bạn bè');
  const ids = [...new Set(documents.map((document) => String(document?.name || '').split('/').pop()).filter(Boolean))];
  const friends = [];
  for (let index = 0; index < ids.length; index += 8) {
    const batch = await Promise.all(ids.slice(index, index + 8).map(async (uid) => {
      try {
        const profileResponse = await request('https://api.locketcamera.com/fetchUserV2', jsonOptions({ data: { user_uid: uid } }, { Authorization: `Bearer ${idToken}` }, device), 'đọc hồ sơ bạn bè');
        return normalizeFriendProfile(profileResponse.body, uid);
      } catch (error) {
        if (error.status === 401) throw error;
        return normalizeFriendProfile({}, uid);
      }
    }));
    friends.push(...batch);
  }
  return friends;
}

async function listFirestoreDocuments(url, idToken, device, stage) {
  const documents = [];
  const seen = new Set();
  let pageToken = null;
  do {
    const pageUrl = new URL(url);
    if (pageToken) pageUrl.searchParams.set('pageToken', pageToken);
    const { body } = await request(pageUrl.href, {
      headers: { ...deviceProfile.headers(device), Authorization: `Bearer ${idToken}` },
    }, stage);
    if (!body || (body.documents !== undefined && !Array.isArray(body.documents))) {
      throw failure(`Locket trả về dữ liệu không hợp lệ khi ${stage}.`);
    }
    documents.push(...(body.documents || []));
    pageToken = body.nextPageToken || null;
    if (pageToken && seen.has(pageToken)) throw failure(`Không thể tải đầy đủ dữ liệu khi ${stage}. Vui lòng thử lại.`);
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return documents;
}

function firestoreValue(fields, key, fallback = null) {
  const value = fields?.[key];
  if (!value) return fallback;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  return fallback;
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function normalizeMoment(moment = {}) {
  const overlays = Array.isArray(moment.overlays) ? moment.overlays : [];
  const overlayText = overlays.map((overlay) => overlay?.data?.text || overlay?.alt_text).find((value) => typeof value === 'string' && value.trim());
  const date = moment.date ?? moment.created_at ?? moment.createdAt ?? null;
  let timestamp = NaN;
  if (date && typeof date === 'object') {
    const seconds = date._seconds ?? date.seconds;
    if (seconds !== null && seconds !== undefined && Number.isFinite(Number(seconds))) timestamp = Number(seconds) * 1000;
  } else if (typeof date === 'number' || (typeof date === 'string' && /^\d+(\.\d+)?$/.test(date))) {
    const value = Number(date);
    timestamp = value < 1e12 ? value * 1000 : value;
  } else if (typeof date === 'string') timestamp = Date.parse(date);
  const parsedDate = new Date(timestamp);
  const createdAt = Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
  const thumbnailUrl = safeHttpsUrl(moment.thumbnail_url) || safeHttpsUrl(moment.thumbnailUrl);
  const imageUrl = safeHttpsUrl(moment.image_url) || safeHttpsUrl(moment.imageUrl);
  return {
    momentId: moment.canonical_uid || moment.moment_uid || moment.momentId || null,
    userUid: moment.user || moment.user_uid || null,
    thumbnailUrl: thumbnailUrl || imageUrl,
    imageUrl: imageUrl || thumbnailUrl,
    videoUrl: safeHttpsUrl(moment.video_url || moment.videoUrl),
    caption: typeof moment.caption === 'string' && moment.caption.trim() ? moment.caption : (overlayText || ''),
    createdAt,
    date: date && typeof date === 'object' ? date : null,
  };
}

async function getMoments(session, { ownOnly = false } = {}) {
  const idToken = await getAccessToken(session);
  const device = deviceProfile.getDevice(session);
  const endpoint = 'https://api.locketcamera.com/getLatestMomentV2';
  const moments = [];
  const seen = new Set();
  let syncToken = null;
  // Prefer Locket's returned cursor. Older responses only expose moment IDs.
  for (let page = 0; page < 200; page += 1) {
    const data = { should_count_missed_moments: true, include_group_moments: true };
    if (ownOnly) data.users = [session.uid];
    if (syncToken) data.sync_token = syncToken;
    const { body } = await request(endpoint, jsonOptions({ data }, { Authorization: `Bearer ${idToken}` }, device), 'đọc kỷ niệm Locket');
    const raw = body?.result?.data ?? body?.data;
    if (!Array.isArray(raw)) {
      if (Number(body?.result?.status) === 304) break;
      throw failure('Locket trả về dữ liệu kỷ niệm không hợp lệ. Vui lòng thử lại.');
    }
    if (!raw.length) break;
    let newCount = 0;
    for (const item of raw) {
      const id = item?.canonical_uid || item?.moment_uid || item?.momentId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const moment = normalizeMoment(item);
      if (moment.momentId && (moment.thumbnailUrl || moment.videoUrl) && (!ownOnly || moment.userUid === session.uid)) moments.push(moment);
      newCount += 1;
    }
    if (newCount === 0 || Number(body?.result?.status) === 304) break;
    const nextToken = body?.result?.sync_token || body?.sync_token
      || raw[raw.length - 1]?.canonical_uid || raw[raw.length - 1]?.moment_uid || raw[raw.length - 1]?.momentId;
    if (typeof nextToken !== 'string' || !nextToken || nextToken === syncToken) break;
    syncToken = nextToken;
    if (page === 199) throw failure('Chưa tải hết kỷ niệm từ Locket. Vui lòng thử lại.');
  }
  return moments.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || '') || 0;
    const rightTime = Date.parse(right.createdAt || '') || 0;
    return rightTime - leftTime;
  });
}

async function getConversations(session) {
  const idToken = await getAccessToken(session);
  const device = deviceProfile.getDevice(session);
  const url = `https://firestore.googleapis.com/v1/projects/locket-4252a/databases/(default)/documents/users/${encodeURIComponent(session.uid)}/conversations?pageSize=100`;
  const docs = await listFirestoreDocuments(url, idToken, device, 'đọc tin nhắn Locket');
  const conversations = docs.map((document) => {
    const fields = document?.fields || {};
    const members = fields.members?.arrayValue?.values?.map((entry) => entry.stringValue).filter(Boolean) || [];
    const peerUid = members.find((uid) => uid !== session.uid) || null;
    const latest = fields.latest_message?.mapValue?.fields || {};
    return {
      conversationId: String(document?.name || '').split('/').pop(),
      peerUid,
      unreadCount: firestoreValue(fields, 'unread_count', 0),
      isRead: firestoreValue(fields, 'is_read', true),
      latestMessage: {
        text: firestoreValue(latest, 'body', ''),
        senderUid: firestoreValue(latest, 'sender', null),
        timestamp: firestoreValue(latest, 'created_at', null),
      },
    };
  }).filter((conversation) => conversation.conversationId && conversation.peerUid);
  const friendProfiles = await getFriends(session).catch(() => []);
  const profileMap = new Map(friendProfiles.map((friend) => [friend.uid, friend]));
  return conversations.map((conversation) => ({ ...conversation, peer: profileMap.get(conversation.peerUid) || normalizeFriendProfile({}, conversation.peerUid) }));
}

async function getMessages(session, conversationId) {
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(conversationId)) throw failure('Cuộc trò chuyện không hợp lệ.', 400);
  const idToken = await getAccessToken(session);
  const device = deviceProfile.getDevice(session);
  const url = `https://firestore.googleapis.com/v1/projects/locket-4252a/databases/(default)/documents/conversations/${encodeURIComponent(conversationId)}/messages?pageSize=100`;
  const documents = await listFirestoreDocuments(url, idToken, device, 'đọc nội dung tin nhắn');
  return documents.map((document) => {
    const fields = document?.fields || {};
    const senderUid = firestoreValue(fields, 'sender', '');
    return {
      messageId: String(document?.name || '').split('/').pop(),
      senderUid,
      isMe: senderUid === session.uid,
      text: firestoreValue(fields, 'body', ''),
      timestamp: firestoreValue(fields, 'created_at', null),
    };
  }).sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
}

async function resolveAudience(session, audience = {}) {
  const mode = audience?.mode || 'all';
  if (mode === 'private') return { sentToSelfOnly: true, sentToAll: false, recipients: [] };
  if (mode === 'all') return { sentToSelfOnly: false, sentToAll: true, recipients: [] };
  if (mode !== 'exclude') throw failure('Lựa chọn người xem không hợp lệ.', 400);

  const excluded = new Set(Array.isArray(audience.excludedIds) ? audience.excludedIds.filter((id) => typeof id === 'string' && id.length <= 128) : []);
  if (!excluded.size) return { sentToSelfOnly: false, sentToAll: true, recipients: [] };
  const friends = await getFriends(session);
  if (!friends.length) throw failure('Không tải được danh sách bạn bè để đăng theo nhóm loại trừ. Hãy thử lại hoặc chọn Tất cả.', 502);
  const recipients = friends.map((friend) => friend.uid).filter((uid) => !excluded.has(uid));
  return { sentToSelfOnly: false, sentToAll: false, recipients };
}

function readDownloadToken(metadata) {
  return typeof metadata?.downloadTokens === 'string'
    ? metadata.downloadTokens.split(',').map((value) => value.trim()).find(Boolean) : null;
}

async function uploadVideo(session, video, contentType, idToken, device) {
  const objectPath = `users/${session.uid}/moments/videos/${randomBytes(10).toString('hex')}.mp4`;
  const storageUrl = `https://firebasestorage.googleapis.com/v0/b/locket-video/o/${encodeURIComponent(objectPath)}`;
  const storageHeaders = { ...deviceProfile.headers(device), Authorization: `Firebase ${idToken}` };
  const { response: start } = await request(
    `${storageUrl}?uploadType=resumable&name=${encodeURIComponent(objectPath)}`,
    jsonOptions({ name: objectPath, contentType: contentType || 'video/mp4', bucket: '', metadata: { creator: session.uid, visibility: 'private' }, cacheControl: 'public, max-age=604800' }, {
      ...storageHeaders,
      'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Content-Length': String(video.length), 'X-Goog-Upload-Content-Type': contentType || 'video/mp4',
      'X-Firebase-Storage-Version': 'ios/12.12.1', 'X-Firebase-GMPID': '1:641029076083:ios:cc8eb46290d69b234fa606',
      'User-Agent': `${device.userAgent} (GTMSUF/1)`,
    }, device), 'chuẩn bị tải video',
  );
  let destination;
  try { destination = new URL(start.headers.get('x-goog-upload-url')); }
  catch { throw failure('Locket không trả về địa chỉ tải video hợp lệ.'); }
  if (destination.protocol !== 'https:' || destination.hostname !== 'firebasestorage.googleapis.com' || destination.username || destination.password || destination.port) {
    throw failure('Locket trả về địa chỉ tải video không được hỗ trợ.');
  }
  const { body: uploaded } = await request(destination.href, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'video/mp4', 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Content-Length': String(video.length) },
    body: video,
  }, 'tải video');
  let downloadToken = readDownloadToken(uploaded);
  if (!downloadToken) {
    const { body: metadata } = await request(storageUrl, { headers: storageHeaders }, 'đọc video đã tải');
    downloadToken = readDownloadToken(metadata);
  }
  if (!downloadToken) throw failure('Locket chưa xác nhận video đã tải lên.');
  return `${storageUrl}?alt=media&token=${encodeURIComponent(downloadToken)}`;
}

const CAPTION_STYLES = Object.freeze({
  pink: { colors: ['#FF5F9E', '#FFB6D9'], textColor: '#FFFFFFE6' },
  purple: { colors: ['#6D4AFF', '#B99CFF'], textColor: '#FFFFFFE6' },
  blue: { colors: ['#3298FF', '#8DD8FF'], textColor: '#FFFFFFE6' },
  green: { colors: ['#2EAA68', '#9DE7B8'], textColor: '#FFFFFFE6' },
  peach: { colors: ['#FF7A59', '#FFD180'], textColor: '#FFFFFFE6' },
  yellow: { colors: ['#FFC107', '#FFE082'], textColor: '#4A3000E6' },
  sand: { colors: ['#A6815D', '#E0C3A0'], textColor: '#FFFFFFE6' },
});

async function upload(session, buffer, caption = '', audience = {}, video = null, videoType = 'video/mp4', captionStyle = 'yellow') {
  const visibility = await resolveAudience(session, audience);
  let image;
  try {
    const source = sharp(buffer, { limitInputPixels: 40000000, failOn: 'error' });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('format');
    image = await source.rotate().resize(1020, 1020, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
  } catch {
    throw failure('Ảnh không hợp lệ. Hãy chọn ảnh JPEG, PNG hoặc WebP tối đa 20 MB.', 400);
  }
  const idToken = await getAccessToken(session);
  const device = deviceProfile.getDevice(session);
  const authorization = { Authorization: `Bearer ${idToken}` };
  const storageHeaders = { ...deviceProfile.headers(device), Authorization: `Firebase ${idToken}` };
  const objectPath = `users/${session.uid}/moments/thumbnails/${randomBytes(10).toString('hex')}.webp`;
  const storageUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(objectPath)}`;
  const { response: start } = await request(
    `${storageUrl}?uploadType=resumable&name=${encodeURIComponent(objectPath)}`,
    jsonOptions({ name: objectPath, contentType: 'image/webp', bucket: '', metadata: { creator: session.uid, visibility: 'private' }, cacheControl: 'public, max-age=604800' }, {
      ...storageHeaders,
      'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Content-Length': String(image.length), 'X-Goog-Upload-Content-Type': 'image/webp',
      'X-Firebase-Storage-Version': 'ios/12.12.1', 'X-Firebase-GMPID': '1:641029076083:ios:cc8eb46290d69b234fa606',
      'User-Agent': `${device.userAgent} (GTMSUF/1)`,
    }, device), 'chuẩn bị tải ảnh',
  );
  // Never forward image bytes to an arbitrary upstream URL.
  let destination;
  try { destination = new URL(start.headers.get('x-goog-upload-url')); }
  catch { throw failure('Locket không trả về địa chỉ tải ảnh hợp lệ.'); }
  if (destination.protocol !== 'https:' || destination.hostname !== 'firebasestorage.googleapis.com' || destination.username || destination.password || destination.port) {
    throw failure('Locket trả về địa chỉ tải ảnh không được hỗ trợ.');
  }
  const { body: uploaded } = await request(destination.href, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Content-Length': String(image.length) },
    body: image,
  }, 'tải ảnh');
  let downloadToken = readDownloadToken(uploaded);
  if (!downloadToken) {
    const { body: metadata } = await request(storageUrl, { headers: storageHeaders }, 'đọc ảnh đã tải');
    downloadToken = readDownloadToken(metadata);
  }
  if (!downloadToken) throw failure('Locket chưa xác nhận ảnh đã tải lên.');
  const thumbnailUrl = `${storageUrl}?alt=media&token=${encodeURIComponent(downloadToken)}`;
  let uploadVideoBuffer = video;
  let uploadVideoType = videoType;
  if (video && videoType.startsWith('video/webm')) {
    uploadVideoBuffer = convertWebmToMp4(video);
    uploadVideoType = 'video/mp4';
  }
  const videoUrl = uploadVideoBuffer ? await uploadVideo(session, uploadVideoBuffer, uploadVideoType, idToken, device) : null;
  const text = caption.trim();
  const style = CAPTION_STYLES[captionStyle] || CAPTION_STYLES.yellow;
  const { body: moment } = await request('https://api.locketcamera.com/postMomentV2', jsonOptions({ data: {
    thumbnail_url: thumbnailUrl,
    ...(videoUrl ? { video_url: videoUrl } : {}),
    sent_to_self_only: visibility.sentToSelfOnly,
    sent_to_all: visibility.sentToAll,
    recipients: visibility.recipients,
    md5: `${randomBytes(16).toString('hex')}_${Math.floor(Date.now() / 1000)}`,
    analytics: deviceProfile.analytics(device),
    overlays: text ? [{
      overlay_id: 'caption:standard', overlay_type: 'caption', alt_text: text,
      data: { text, type: 'standard', text_color: style.textColor, max_lines: { '@type': 'type.googleapis.com/google.protobuf.Int64Value', value: '4' }, background: { colors: style.colors, material_blur: 'regular' } },
    }] : [],
  } }, authorization, device), 'đăng ảnh');
  const momentId = moment?.result?.data?.canonical_uid || moment?.result?.data?.moment_uid || moment?.result?.moment_uid;
  if (typeof momentId !== 'string' || !momentId.trim()) {
    throw failure('Locket chưa xác nhận bài đăng. Kiểm tra ứng dụng trước khi gửi lại để tránh trùng bài.');
  }
  return { momentId, thumbnailUrl, ...(videoUrl ? { videoUrl } : {}) };
}

module.exports = { login, upload, getFriends, getProfile, updateProfile, getMoments, getConversations, getMessages };
