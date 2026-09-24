import asyncHandler from '../utils/asyncHandler.js';
import { deleteUserForAdmin, listUsersForAdmin } from '../services/userService.js';

/** GET /api/admin/users */
export const getAdminUsers = asyncHandler(async (req, res) => {
  const result = await listUsersForAdmin(req.query);
  res.json({ success: true, ...result });
});

/** DELETE /api/admin/users/:id */
export const deleteAdminUser = asyncHandler(async (req, res) => {
  const user = await deleteUserForAdmin(req.params.id);
  res.json({ success: true, message: `${user.email} was deleted.` });
});
