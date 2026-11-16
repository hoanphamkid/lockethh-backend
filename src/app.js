const express = require('express');
const cors = require('cors');
const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const uploadRoutes = require('./routes/upload.routes');
const friendsRoutes = require('./routes/friends.routes');
const configRoutes = require('./routes/config.routes');
const socialRoutes = require('./routes/social.routes');
const { errorHandler, notFoundHandler } = require('./middleware/error.middleware');

const app = express();
app.disable('x-powered-by');
const allowedOrigins = new Set([process.env.FRONTEND_URL || 'http://localhost:5173', 'http://localhost:5173', 'http://localhost:5174']);
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), credentials: true }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // This custom header requires a CORS preflight, preventing cross-site form posts.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Locket-Client') !== 'studio') {
    return res.status(403).json({ success: false, message: 'Yêu cầu không hợp lệ. Hãy tải lại trang.' });
  }
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/social', socialRoutes);
app.use('/', configRoutes);
app.use('/api/config', configRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
