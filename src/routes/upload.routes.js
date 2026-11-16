const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const requireLocket = require('../middleware/auth.middleware');
const locket = require('../services/locket.service');
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 2, fields: 3, fieldSize: 4096, parts: 5 },
  fileFilter: (req, file, done) => {
    if (['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/x-m4v'].includes(file.mimetype) || file.mimetype.startsWith('video/webm')) return done(null, true);
    done(Object.assign(new Error('Chỉ hỗ trợ ảnh JPEG, PNG, WebP hoặc video MP4/MOV/WebM.'), { status: 400 }));
  },
});

router.post('/', requireLocket, rateLimit({
  windowMs: 60000, limit: 5, keyGenerator: (req) => req.locketSession.uid,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message: 'Bạn gửi quá nhanh. Hãy thử lại sau một phút.' },
}), upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res, next) => {
  const image = req.files?.image?.[0];
  const video = req.files?.video?.[0];
  if (!image && !video) return res.status(400).json({ success: false, message: 'Hãy chọn ảnh hoặc video để đăng.' });
  if (image && image.size > 5 * 1024 * 1024) return res.status(413).json({ success: false, message: 'Ảnh vượt dung lượng cho phép. Vui lòng chọn ảnh tối đa 5 MB.' });
  if (video && video.size > 10 * 1024 * 1024) return res.status(413).json({ success: false, message: 'Video vượt dung lượng cho phép. Vui lòng chọn video tối đa 10 MB.' });
  if (video && !image) return res.status(400).json({ success: false, message: 'Video cần một ảnh xem trước. Hãy chọn lại video từ album.' });
  const caption = req.body.caption ?? '';
  if (typeof caption !== 'string' || caption.length > 120) {
    return res.status(400).json({ success: false, message: 'Chú thích tối đa 120 ký tự.' });
  }
  const captionStyle = req.body.captionStyle ?? 'yellow';
  if (typeof captionStyle !== 'string' || !['pink', 'purple', 'blue', 'green', 'peach', 'yellow', 'sand'].includes(captionStyle)) {
    return res.status(400).json({ success: false, message: 'Kiểu chú thích không hợp lệ.' });
  }
  let audience = { mode: 'all', excludedIds: [] };
  if (req.body.audience) {
    try { audience = JSON.parse(req.body.audience); }
    catch { return res.status(400).json({ success: false, message: 'Cài đặt người xem không hợp lệ.' }); }
  }
  if (!audience || !['private', 'all', 'exclude'].includes(audience.mode) || (audience.excludedIds !== undefined && !Array.isArray(audience.excludedIds))) {
    return res.status(400).json({ success: false, message: 'Cài đặt người xem không hợp lệ.' });
  }
  if (req.locketSession.posting) return res.status(409).json({ success: false, message: 'Một ảnh đang được đăng. Vui lòng đợi.' });
  req.locketSession.posting = true;
  try {
    const data = await locket.upload(req.locketSession, image.buffer, caption, audience, video?.buffer, video?.mimetype, captionStyle);
    res.json({ success: true, data });
  } catch (error) { next(error); }
  finally { req.locketSession.posting = false; }
});

module.exports = router;

