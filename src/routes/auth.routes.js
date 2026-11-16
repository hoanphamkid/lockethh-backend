const express = require('express');
const { rateLimit } = require('express-rate-limit');
const locket = require('../services/locket.service');
const sessions = require('../services/session.service');
const requireLocket = require('../middleware/auth.middleware');
const router = express.Router();

router.get('/session', (req, res) => {
  const session = sessions.get(req);
  res.json({ success: true, user: session ? sessions.user(session) : null });
});

router.get('/profile', requireLocket, async (req, res, next) => {
  try {
    const profile = await locket.getProfile(req.locketSession);
    req.locketSession.profile = profile;
    res.json({ success: true, data: profile });
  } catch (error) { next(error); }
});

router.patch('/profile', requireLocket, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (JSON.stringify(body).length > 2000) return res.status(400).json({ success: false, message: 'Thông tin hồ sơ quá dài.' });
    const data = await locket.updateProfile(req.locketSession, body);
    req.locketSession.profile = data;
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/login', rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message: 'Bạn đã thử đăng nhập quá nhiều lần. Hãy thử lại sau 15 phút.' },
}), async (req, res, next) => {
  const { password } = req.body;
  const rawIdentifier = req.body.identifier ?? req.body.email;
  const identifier = typeof rawIdentifier === 'string' ? rawIdentifier.trim() : '';
  const validIdentifier = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier) || /^\+[1-9]\d{7,14}$/.test(identifier);
  if (!validIdentifier || identifier.length > 254 || typeof password !== 'string' || !password || password.length > 4096) {
    return res.status(400).json({ success: false, message: 'Nhập email hoặc số điện thoại có mã quốc gia (ví dụ +84901234567), cùng mật khẩu Locket.' });
  }
  try {
    const credentials = await locket.login(identifier, password);
    sessions.create(req, res, credentials);
    res.json({ success: true, user: sessions.user(credentials) });
  } catch (error) { next(error); }
});

router.post('/logout', (req, res) => {
  sessions.remove(req, res);
  res.json({ success: true });
});

module.exports = router;
