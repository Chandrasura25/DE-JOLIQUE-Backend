import asyncHandler from '../utils/asyncHandler.js';
import AppError from '../utils/AppError.js';
import { detectImageType } from '../middleware/upload.js';
import { uploadImage } from '../services/storage.js';

/** POST /api/admin/uploads (multipart, field "images") -> [{ url, key, provider }] */
export const uploadImages = asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw AppError.badRequest('Choose at least one image to upload.');

  for (const file of files) {
    const detected = detectImageType(file.buffer);
    if (!detected) throw AppError.badRequest(`"${file.originalname}" is not a valid image file.`);
    file.mimetype = detected;
  }

  const images = [];
  for (const file of files) {
    images.push(await uploadImage(file));
  }
  res.status(201).json({ success: true, images });
});
