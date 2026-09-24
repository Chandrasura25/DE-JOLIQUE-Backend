import { Router } from 'express';
import { adminOnly } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { imageUpload, MAX_IMAGES_PER_UPLOAD } from '../middleware/upload.js';
import { getAdminProduct, getAdminProducts } from '../controllers/productController.js';
import {
  createCategoryHandler,
  deleteCategoryHandler,
  updateCategoryHandler,
} from '../controllers/categoryController.js';
import {
  getAdminOrder,
  getAdminOrders,
  getStats,
  updateOrderStatusHandler,
} from '../controllers/orderController.js';
import { uploadImages } from '../controllers/uploadController.js';
import { deleteAdminUser, getAdminUsers } from '../controllers/userController.js';
import {
  adminOrderListQuery,
  adminUserListQuery,
  categoryBody,
  idParam,
  productListQuery,
  updateCategoryBody,
  updateOrderStatusBody,
} from '../validators/schemas.js';

const router = Router();

// Every admin API re-checks the caller's role from the database.
router.use(adminOnly);

router.get('/stats', getStats);

router.get('/products', validate({ query: productListQuery }), getAdminProducts);
router.get('/products/:id', validate({ params: idParam }), getAdminProduct);

router.post('/categories', validate({ body: categoryBody }), createCategoryHandler);
router.put('/categories/:id', validate({ params: idParam, body: updateCategoryBody }), updateCategoryHandler);
router.delete('/categories/:id', validate({ params: idParam }), deleteCategoryHandler);

router.get('/orders', validate({ query: adminOrderListQuery }), getAdminOrders);
router.get('/orders/:id', validate({ params: idParam }), getAdminOrder);
router.put('/orders/:id/status', validate({ params: idParam, body: updateOrderStatusBody }), updateOrderStatusHandler);

router.get('/users', validate({ query: adminUserListQuery }), getAdminUsers);
router.delete('/users/:id', validate({ params: idParam }), deleteAdminUser);

router.post('/uploads', imageUpload.array('images', MAX_IMAGES_PER_UPLOAD), uploadImages);

export default router;
