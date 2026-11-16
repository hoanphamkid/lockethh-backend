const sessions = require('../services/session.service');

module.exports = (req, res, next) => {
  const session = sessions.get(req);
  if (!session) return res.status(401).json({ success: false, message: 'Hãy kết nối tài khoản Locket trước khi đăng ảnh.' });
  req.locketSession = session;
  next();
};

