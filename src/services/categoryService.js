import { query } from '../config/db.js';
import AppError from '../utils/AppError.js';
import { slugify } from '../utils/helpers.js';

export function toCategoryDto(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    productCount: row.product_count ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCategories({ includeEmpty = true } = {}) {
  const { rows } = await query(
    `select c.*, count(p.id) filter (where p.is_active)::int as product_count
       from public.categories c
       left join public.products p on p.category_id = c.id
      group by c.id
      ${includeEmpty ? '' : 'having count(p.id) filter (where p.is_active) > 0'}
      order by c.name`,
  );
  return rows.map(toCategoryDto);
}

export async function createCategory({ name, description }) {
  const slug = slugify(name);
  if (!slug) throw AppError.badRequest('Category name must contain letters or numbers.');
  const { rows } = await query(
    'insert into public.categories (name, slug, description) values ($1, $2, $3) returning *',
    [name, slug, description ?? ''],
  ).catch((err) => {
    if (err.code === '23505') throw AppError.conflict('A category with that name already exists.');
    throw err;
  });
  return toCategoryDto(rows[0]);
}

export async function updateCategory(id, { name, description }) {
  const { rows } = await query(
    `update public.categories
        set name = coalesce($2, name),
            slug = coalesce($3, slug),
            description = coalesce($4, description)
      where id = $1
      returning *`,
    [id, name ?? null, name ? slugify(name) : null, description ?? null],
  ).catch((err) => {
    if (err.code === '23505') throw AppError.conflict('A category with that name already exists.');
    throw err;
  });
  if (!rows[0]) throw AppError.notFound('Category not found.');
  return toCategoryDto(rows[0]);
}

/** Products in a deleted category become uncategorised (category_id is set null). */
export async function deleteCategory(id) {
  const { rowCount } = await query('delete from public.categories where id = $1', [id]);
  if (!rowCount) throw AppError.notFound('Category not found.');
}
