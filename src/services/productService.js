import env from '../config/env.js';
import { query } from '../config/db.js';
import AppError from '../utils/AppError.js';
import { escapeLike, isUuid, paginationMeta, randomSuffix, slugify } from '../utils/helpers.js';
import { deleteImages } from './storage.js';

const SELECT = `
  select p.*, c.name as category_name, c.slug as category_slug
    from public.products p
    left join public.categories c on c.id = p.category_id`;

export function toProductDto(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    price: row.price,
    stock: row.stock,
    inStock: row.stock > 0,
    lowStock: row.stock > 0 && row.stock <= env.LOW_STOCK_THRESHOLD,
    images: row.images || [],
    featured: row.featured,
    isActive: row.is_active,
    category: row.category_id ? { id: row.category_id, name: row.category_name, slug: row.category_slug } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SORTS = {
  newest: 'p.created_at desc, p.id',
  oldest: 'p.created_at asc, p.id',
  price_asc: 'p.price asc, p.id',
  price_desc: 'p.price desc, p.id',
  name: 'p.name asc, p.id',
  stock_asc: 'p.stock asc, p.id',
};

/**
 * Shared list query for the storefront and the admin. Every user value is passed
 * as a bind parameter; the sort column comes from a fixed whitelist.
 */
export async function listProducts(filters, { admin = false } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };

  if (!admin) where.push('p.is_active');
  if (filters.search) add("(p.name ilike ? or p.description ilike ?)", `%${escapeLike(filters.search)}%`);
  if (filters.category) {
    if (isUuid(filters.category)) add('p.category_id = ?', filters.category);
    else add('c.slug = ?', filters.category);
  }
  if (filters.minPrice != null) add('p.price >= ?', filters.minPrice);
  if (filters.maxPrice != null) add('p.price <= ?', filters.maxPrice);
  if (filters.featured) where.push('p.featured');
  if (filters.inStock) where.push('p.stock > 0');
  if (admin && filters.status === 'active') where.push('p.is_active');
  if (admin && filters.status === 'hidden') where.push('not p.is_active');
  if (admin && filters.stock === 'out') where.push('p.stock = 0');
  if (admin && filters.stock === 'low') add('p.stock > 0 and p.stock <= ?', env.LOW_STOCK_THRESHOLD);
  if (admin && filters.stock === 'in') add('p.stock > ?', env.LOW_STOCK_THRESHOLD);

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const { page, limit } = filters;

  const [{ rows }, count] = await Promise.all([
    query(
      `${SELECT} ${whereSql} order by ${SORTS[filters.sort] || SORTS.newest}
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    ),
    query(
      `select count(*)::int as total from public.products p
         left join public.categories c on c.id = p.category_id ${whereSql}`,
      params,
    ),
  ]);

  return { products: rows.map(toProductDto), pagination: paginationMeta(page, limit, count.rows[0].total) };
}

/** Looks a product up by id or slug. Hidden products are only visible to admins. */
export async function getProduct(idOrSlug, { admin = false } = {}) {
  const column = isUuid(idOrSlug) ? 'p.id' : 'p.slug';
  const { rows } = await query(`${SELECT} where ${column} = $1 ${admin ? '' : 'and p.is_active'}`, [idOrSlug]);
  if (!rows[0]) throw AppError.notFound('Product not found.');
  return toProductDto(rows[0]);
}

async function uniqueSlug(name, excludeId) {
  const base = slugify(name) || 'product';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix(2)}`;
    const { rowCount } = await query('select 1 from public.products where slug = $1 and id is distinct from $2', [
      candidate,
      excludeId ?? null,
    ]);
    if (!rowCount) return candidate;
  }
  return `${base}-${randomSuffix(4)}`;
}

async function assertCategory(categoryId) {
  if (!categoryId) return;
  const { rowCount } = await query('select 1 from public.categories where id = $1', [categoryId]);
  if (!rowCount) throw AppError.badRequest('The selected category does not exist.');
}

export async function createProduct(input) {
  await assertCategory(input.categoryId);
  const slug = await uniqueSlug(input.name);
  const { rows } = await query(
    `insert into public.products (name, slug, description, price, category_id, stock, images, featured, is_active)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     returning id`,
    [
      input.name,
      slug,
      input.description,
      input.price,
      input.categoryId || null,
      input.stock,
      JSON.stringify(input.images),
      input.featured,
      input.isActive,
    ],
  );
  return getProduct(rows[0].id, { admin: true });
}

export async function updateProduct(id, input) {
  const existing = await getProduct(id, { admin: true });
  if (input.categoryId !== undefined) await assertCategory(input.categoryId);

  const next = {
    name: input.name ?? existing.name,
    slug: input.name && input.name !== existing.name ? await uniqueSlug(input.name, id) : existing.slug,
    description: input.description ?? existing.description,
    price: input.price ?? existing.price,
    categoryId: input.categoryId !== undefined ? input.categoryId || null : existing.category?.id ?? null,
    stock: input.stock ?? existing.stock,
    images: input.images ?? existing.images,
    featured: input.featured ?? existing.featured,
    isActive: input.isActive ?? existing.isActive,
  };

  await query(
    `update public.products
        set name = $2, slug = $3, description = $4, price = $5, category_id = $6,
            stock = $7, images = $8::jsonb, featured = $9, is_active = $10
      where id = $1`,
    [id, next.name, next.slug, next.description, next.price, next.categoryId, next.stock,
      JSON.stringify(next.images), next.featured, next.isActive],
  );

  // Remove files for images the admin took off the product.
  const keep = new Set(next.images.map((img) => img.key || img.url));
  await deleteImages(existing.images.filter((img) => !keep.has(img.key || img.url)));

  return getProduct(id, { admin: true });
}

export async function deleteProduct(id) {
  const existing = await getProduct(id, { admin: true });
  // Order items keep a snapshot (name/price/image), so past orders stay intact.
  await query('delete from public.products where id = $1', [id]);
  await deleteImages(existing.images);
  return existing;
}

/** Current price/stock for cart items, so the cart never relies on stale client data. */
export async function validateCartItems(items) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const { rows } = await query(`${SELECT} where p.id = any($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return items.map(({ productId, quantity }) => {
    const row = byId.get(productId);
    if (!row || !row.is_active) {
      return { productId, quantity, available: false, maxQuantity: 0, product: null, message: 'No longer available' };
    }
    const product = toProductDto(row);
    const maxQuantity = product.stock;
    let message = null;
    if (maxQuantity === 0) message = 'Out of stock';
    else if (quantity > maxQuantity) message = `Only ${maxQuantity} left in stock`;
    return { productId, quantity, available: maxQuantity > 0, maxQuantity, product, message };
  });
}
