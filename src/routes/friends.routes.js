const express = require('express');
const { rateLimit } = require('express-rate-limit');
const requireLocket = require('../middleware/auth.middleware');
const locket = require('../services/locket.service');

const router = express.Router();

router.get('/', requireLocket, rateLimit({
  windowMs: 60000,
  limit: 6,
  keyGenerator: (req) => req.locketSession.uid,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Bạn tải danh sách bạn bè quá nhanh. Hãy thử lại sau.' },
}), async (req, res, next) => {
  try {
    const friends = await locket.getFriends(req.locketSession);
    res.json({ success: true, data: friends });
  } catch (error) { next(error); }
});

module.exports = router;
