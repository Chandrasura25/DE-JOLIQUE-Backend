import crypto from 'node:crypto';

export function slugify(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export const randomSuffix = (bytes = 3) => crypto.randomBytes(bytes).toString('hex');

/** Rounds to 2 decimal places without binary floating point drift. */
export const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/** Major currency units (naira) -> minor units (kobo), as an integer. */
export const toMinorUnits = (value) => Math.round(Number(value) * 100);

export const isUuid = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Escapes LIKE/ILIKE wildcards in user input. */
export const escapeLike = (value) => String(value).replace(/[\\%_]/g, (c) => `\\${c}`);

export function paginationMeta(page, limit, total) {
  return { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}
