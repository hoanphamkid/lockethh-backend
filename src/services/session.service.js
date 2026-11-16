const { randomBytes } = require('node:crypto');
const sessions = new Map();
const COOKIE = 'locket_session';
const MAX_AGE = 12 * 60 * 60 * 1000;
// When the frontend is hosted on Vercel and the API is hosted separately,
// the session cookie must be allowed in a cross-origin fetch. Keep the safer
// same-site default for local/same-origin deployments.
const crossOriginCookies = process.env.CROSS_ORIGIN_COOKIES === 'true';
const cookieOptions = {
  httpOnly: true,
  sameSite: crossOriginCookies ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production' || crossOriginCookies,
  path: '/api',
  maxAge: MAX_AGE,
};

function sessionId(req) {
  const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return cookie?.slice(COOKIE.length + 1);
}

function invalidate(req) {
  sessions.delete(sessionId(req));
}

function remove(req, res) {
  invalidate(req);
  res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
}

function create(req, res, credentials) {
  sessions.delete(sessionId(req));
  const id = randomBytes(32).toString('hex');
  sessions.set(id, { ...credentials, expiresAt: Date.now() + MAX_AGE });
  res.cookie(COOKIE, id, cookieOptions);
}

function get(req) {
  const id = sessionId(req);
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function user(session) {
  return { uid: session.uid, email: session.email, phoneNumber: session.phoneNumber, displayName: session.displayName, ...(session.profile || {}) };
}

const cleanup = setInterval(() => {
  for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);
}, 60000);
cleanup.unref();

module.exports = { create, get, remove, invalidate, user };
