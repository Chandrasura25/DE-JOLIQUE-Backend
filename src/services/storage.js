import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import env from '../config/env.js';

/**
 * Pluggable image storage. Select with STORAGE_PROVIDER=supabase|cloudinary|s3|local.
 * Every provider returns { url, key, provider } so product rows never depend on
 * which backend stored the file.
 */

export const LOCAL_UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const newKey = (mimetype) => `products/${Date.now()}-${crypto.randomUUID()}.${EXTENSIONS[mimetype] || 'bin'}`;

const localProvider = {
  async upload(file) {
    const key = newKey(file.mimetype);
    const target = path.join(LOCAL_UPLOAD_DIR, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.buffer);
    return { url: `${env.SERVER_URL.replace(/\/+$/, '')}/uploads/${key}`, key, provider: 'local' };
  },
  async remove(image) {
    const target = path.resolve(LOCAL_UPLOAD_DIR, image.key);
    if (!target.startsWith(LOCAL_UPLOAD_DIR)) return;
    await fs.unlink(target).catch(() => {});
  },
};

let bucketReady = null;
const supabaseProvider = {
  async client() {
    const { supabaseAdmin } = await import('../config/supabase.js');
    if (!bucketReady) {
      bucketReady = (async () => {
        const { data } = await supabaseAdmin.storage.getBucket(env.SUPABASE_STORAGE_BUCKET);
        if (!data) {
          const { error } = await supabaseAdmin.storage.createBucket(env.SUPABASE_STORAGE_BUCKET, {
            public: true,
            fileSizeLimit: '5MB',
            allowedMimeTypes: Object.keys(EXTENSIONS),
          });
          if (error && !/already exists/i.test(error.message)) throw error;
        }
      })().catch((err) => {
        bucketReady = null;
        throw err;
      });
    }
    await bucketReady;
    return supabaseAdmin;
  },
  async upload(file) {
    const supabase = await this.client();
    const key = newKey(file.mimetype);
    const bucket = supabase.storage.from(env.SUPABASE_STORAGE_BUCKET);
    const { error } = await bucket.upload(key, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
    return { url: bucket.getPublicUrl(key).data.publicUrl, key, provider: 'supabase' };
  },
  async remove(image) {
    const supabase = await this.client();
    await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).remove([image.key]);
  },
};

let cloudinaryClient = null;
const cloudinaryProvider = {
  async client() {
    if (!cloudinaryClient) {
      const { v2 } = await import('cloudinary');
      v2.config({
        cloud_name: env.CLOUDINARY_CLOUD_NAME,
        api_key: env.CLOUDINARY_API_KEY,
        api_secret: env.CLOUDINARY_API_SECRET,
        secure: true,
      });
      cloudinaryClient = v2;
    }
    return cloudinaryClient;
  },
  async upload(file) {
    const cloudinary = await this.client();
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: env.CLOUDINARY_FOLDER, resource_type: 'image' },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
      stream.end(file.buffer);
    });
    return { url: result.secure_url, key: result.public_id, provider: 'cloudinary' };
  },
  async remove(image) {
    const cloudinary = await this.client();
    await cloudinary.uploader.destroy(image.key);
  },
};

let s3Client = null;
const s3Provider = {
  async client() {
    if (!s3Client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      s3Client = new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT, // set for Cloudflare R2 / MinIO; leave empty for AWS
        credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      });
    }
    return s3Client;
  },
  async upload(file) {
    const client = await this.client();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const key = newKey(file.mimetype);
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return { url: `${env.S3_PUBLIC_URL.replace(/\/+$/, '')}/${key}`, key, provider: 's3' };
  },
  async remove(image) {
    const client = await this.client();
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: image.key }));
  },
};

const providers = {
  local: localProvider,
  supabase: supabaseProvider,
  cloudinary: cloudinaryProvider,
  s3: s3Provider,
};

export async function uploadImage(file) {
  return providers[env.STORAGE_PROVIDER].upload(file);
}

/**
 * Best-effort delete. Images with provider "external" (e.g. seeded sample images
 * hosted elsewhere) are never touched.
 */
export async function deleteImages(images = []) {
  await Promise.all(
    images
      .filter((img) => img?.key && providers[img.provider])
      .map((img) =>
        providers[img.provider].remove(img).catch((err) => {
          console.warn(`Could not delete image ${img.key} from ${img.provider}: ${err.message}`);
        }),
      ),
  );
}
