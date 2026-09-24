import asyncHandler from '../utils/asyncHandler.js';
import AppError from '../utils/AppError.js';
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
  validateCartItems,
} from '../services/productService.js';

/** GET /api/products — storefront listing (active products only). */
export const getProducts = asyncHandler(async (req, res) => {
  if (req.query.minPrice != null && req.query.maxPrice != null && req.query.minPrice > req.query.maxPrice) {
    throw AppError.badRequest('Minimum price cannot be greater than maximum price.');
  }
  const { status, stock, ...filters } = req.query;
  const result = await listProducts(filters);
  res.json({ success: true, ...result });
});

/** GET /api/products/:id — by id or slug. */
export const getProductById = asyncHandler(async (req, res) => {
  const product = await getProduct(req.params.id);
  res.json({ success: true, product });
});

/** POST /api/products (admin) */
export const createProductHandler = asyncHandler(async (req, res) => {
  const product = await createProduct(req.body);
  res.status(201).json({ success: true, message: 'Product created.', product });
});

/** PUT /api/products/:id (admin) */
export const updateProductHandler = asyncHandler(async (req, res) => {
  const product = await updateProduct(req.params.id, req.body);
  res.json({ success: true, message: 'Product updated.', product });
});

/** DELETE /api/products/:id (admin) */
export const deleteProductHandler = asyncHandler(async (req, res) => {
  await deleteProduct(req.params.id);
  res.json({ success: true, message: 'Product deleted.' });
});

/** GET /api/admin/products — includes hidden products and stock filters. */
export const getAdminProducts = asyncHandler(async (req, res) => {
  const result = await listProducts(req.query, { admin: true });
  res.json({ success: true, ...result });
});

/** GET /api/admin/products/:id */
export const getAdminProduct = asyncHandler(async (req, res) => {
  const product = await getProduct(req.params.id, { admin: true });
  res.json({ success: true, product });
});

/** POST /api/cart/validate — current price and stock for the items in a cart. */
export const validateCart = asyncHandler(async (req, res) => {
  const items = await validateCartItems(req.body.items);
  res.json({ success: true, items });
});
