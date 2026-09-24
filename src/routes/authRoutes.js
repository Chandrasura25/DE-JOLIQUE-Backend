import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimiters.js';
import {
  authCallback,
  changeMyPassword,
  forgotPassword,
  getMe,
  getProviders,
  googleSignIn,
  oneTapNonce,
  oneTapSignIn,
  login,
  logout,
  register,
  resetMyPassword,
  updateMe,
} from '../controllers/authController.js';
import {
  changePasswordBody,
  forgotPasswordBody,
  loginBody,
  oauthStartQuery,
  oneTapBody,
  registerBody,
  resetPasswordBody,
  updateProfileBody,
} from '../validators/schemas.js';

const router = Router();

router.get('/providers', getProviders);
router.post('/register', authLimiter, validate({ body: registerBody }), register);
router.post('/login', authLimiter, validate({ body: loginBody }), login);
router.post('/logout', logout);
router.get('/google', authLimiter, validate({ query: oauthStartQuery }), googleSignIn);
router.get('/google/one-tap/nonce', authLimiter, oneTapNonce);
router.post('/google/one-tap', authLimiter, validate({ body: oneTapBody }), oneTapSignIn);
router.get('/callback', authLimiter, authCallback);
router.post('/forgot-password', authLimiter, validate({ body: forgotPasswordBody }), forgotPassword);
router.post('/reset-password', authLimiter, protect, validate({ body: resetPasswordBody }), resetMyPassword);

router.get('/me', protect, getMe);
router.put('/me', protect, validate({ body: updateProfileBody }), updateMe);
router.put('/change-password', authLimiter, protect, validate({ body: changePasswordBody }), changeMyPassword);

export default router;
