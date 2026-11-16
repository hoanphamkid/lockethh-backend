const multer = require('multer');
const sessions = require('../services/session.service');
module.exports = {
  notFoundHandler: (req, res, next) => {
    res.status(404).json({ success: false, message: 'Không tìm thấy API.' });
  },
  errorHandler: (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ success: false, message: tooLarge ? 'Ảnh tối đa 5 MB, video tối đa 10 MB.' : 'Yêu cầu không hợp lệ. Chỉ gửi một ảnh và chú thích tối đa 120 ký tự.' });
    }
    const status = err.status || 500;
    if (status === 401 && req.locketSession) sessions.remove(req, res);
    // Do not log request bodies, cookies, credentials or upstream responses.
    if (status >= 500) console.error(`Request failed: ${req.method} ${req.path} (${status})`);
    res.status(status).json({ success: false, message: status === 500 ? 'Máy chủ gặp lỗi. Vui lòng thử lại.' : err.message });
  }
};
