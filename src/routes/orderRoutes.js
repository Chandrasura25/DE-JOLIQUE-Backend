import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { paymentLimiter } from '../middleware/rateLimiters.js';
import { cancelMyOrder, createOrderHandler, getMyOrders, getOrder } from '../controllers/orderController.js';
import { createOrderBody, idParam, pageQuery } from '../validators/schemas.js';

const router = Router();

router.use(protect);

router.post('/', paymentLimiter, validate({ body: createOrderBody }), createOrderHandler);
router.get('/my-orders', validate({ query: pageQuery }), getMyOrders);
router.get('/:id', validate({ params: idParam }), getOrder);
router.post('/:id/cancel', validate({ params: idParam }), cancelMyOrder);

export default router;
