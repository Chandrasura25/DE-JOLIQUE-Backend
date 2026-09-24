import { Router } from 'express';
import validate from '../middleware/validate.js';
import { validateCart } from '../controllers/productController.js';
import { cartValidateBody } from '../validators/schemas.js';

const router = Router();

router.post('/validate', validate({ body: cartValidateBody }), validateCart);

export default router;
