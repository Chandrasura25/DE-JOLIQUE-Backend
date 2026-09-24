import multer from 'multer';
import AppError from '../utils/AppError.js';

export const MAX_IMAGES_PER_UPLOAD = 6;
// Vercel rejects request bodies over 4.5 MB, so the admin uploads one image per
// request and each image must leave room for the multipart overhead.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Files are held in memory only long enough to hand them to the storage provider. */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_UPLOAD },
  fileFilter(req, file, cb) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      return cb(AppError.badRequest('Only JPEG, PNG, WebP or GIF images are allowed.'));
    }
    return cb(null, true);
  },
});

/**
 * The browser-supplied mimetype can be spoofed, so confirm the file really is the
 * image type it claims to be by checking its signature bytes.
 */
export function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return null;
}
