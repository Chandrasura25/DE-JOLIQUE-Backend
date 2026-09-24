import { Router } from 'express';
import { adminOnly } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import {
  createProductHandler,
  deleteProductHandler,
  getProductById,
  getProducts,
  updateProductHandler,
} from '../controllers/productController.js';
import {
  createProductBody,
  idParam,
  productIdOrSlugParam,
  productListQuery,
  updateProductBody,
} from '../validators/schemas.js';

const router = Router();

router.get('/', validate({ query: productListQuery }), getProducts);
router.get('/:id', validate({ params: productIdOrSlugParam }), getProductById);

router.post('/', adminOnly, validate({ body: createProductBody }), createProductHandler);
router.put('/:id', adminOnly, validate({ params: idParam, body: updateProductBody }), updateProductHandler);
router.delete('/:id', adminOnly, validate({ params: idParam }), deleteProductHandler);

export default router;
