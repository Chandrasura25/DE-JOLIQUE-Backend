import asyncHandler from '../utils/asyncHandler.js';
import { createCategory, deleteCategory, listCategories, updateCategory } from '../services/categoryService.js';

/** GET /api/categories */
export const getCategories = asyncHandler(async (req, res) => {
  const categories = await listCategories();
  res.json({ success: true, categories });
});

/** POST /api/admin/categories */
export const createCategoryHandler = asyncHandler(async (req, res) => {
  const category = await createCategory(req.body);
  res.status(201).json({ success: true, message: 'Category created.', category });
});

/** PUT /api/admin/categories/:id */
export const updateCategoryHandler = asyncHandler(async (req, res) => {
  const category = await updateCategory(req.params.id, req.body);
  res.json({ success: true, message: 'Category updated.', category });
});

/** DELETE /api/admin/categories/:id */
export const deleteCategoryHandler = asyncHandler(async (req, res) => {
  await deleteCategory(req.params.id);
  res.json({ success: true, message: 'Category deleted. Its products are now uncategorised.' });
});
