const express = require('express');
const requireLocket = require('../middleware/auth.middleware');
const locket = require('../services/locket.service');

const router = express.Router();

router.get('/memories', requireLocket, async (req, res, next) => {
  // The owner is always the authenticated session, never a UID from the browser.
  try { res.json({ success: true, data: await locket.getMoments(req.locketSession, { ownOnly: true }) }); }
  catch (error) { next(error); }
});

router.get('/moments', requireLocket, async (req, res, next) => {
  try { res.json({ success: true, data: await locket.getMoments(req.locketSession) }); }
  catch (error) { next(error); }
});

router.get('/conversations', requireLocket, async (req, res, next) => {
  try { res.json({ success: true, data: await locket.getConversations(req.locketSession) }); }
  catch (error) { next(error); }
});

router.get('/conversations/:conversationId/messages', requireLocket, async (req, res, next) => {
  try { res.json({ success: true, data: await locket.getMessages(req.locketSession, req.params.conversationId) }); }
  catch (error) { next(error); }
});

module.exports = router;
