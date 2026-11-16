const sessions = require('../services/session.service');

module.exports = (req, res, next) => {
  const session = sessions.get(req);
  if (!session) return res.status(401).json({ success: false, code: 'SESSION_REQUIRED', requiresLogin: true, message: 'Phiên đăng nhập không còn khả dụng. Hãy kết nối lại tài khoản Locket.' });
  req.locketSession = session;
  next();
};

