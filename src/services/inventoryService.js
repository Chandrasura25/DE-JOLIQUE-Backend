/**
 * Inventory changes. Always called with a client inside a transaction.
 *
 * The conditional UPDATE (stock >= quantity) takes a row lock, so when two buyers race
 * for the last unit the second transaction waits, re-checks the condition against the
 * committed stock and matches zero rows. The CHECK (stock >= 0) constraint is a final
 * backstop. Items are processed in product-id order so concurrent orders that share
 * products lock rows in the same order and cannot deadlock.
 */

const byProductId = (a, b) => String(a.product_id).localeCompare(String(b.product_id));

/**
 * Deducts stock for every item or for none of them.
 * Returns { ok: true } or { ok: false, unavailable: [{ productId, name }] }.
 */
export async function commitStock(client, items) {
  await client.query('savepoint commit_stock');
  const unavailable = [];

  for (const item of [...items].sort(byProductId)) {
    if (!item.product_id) {
      unavailable.push({ productId: null, name: item.name });
      continue;
    }
    const { rowCount } = await client.query(
      'update public.products set stock = stock - $2 where id = $1 and stock >= $2',
      [item.product_id, item.quantity],
    );
    if (!rowCount) unavailable.push({ productId: item.product_id, name: item.name });
  }

  if (unavailable.length) {
    await client.query('rollback to savepoint commit_stock');
    return { ok: false, unavailable };
  }
  await client.query('release savepoint commit_stock');
  return { ok: true };
}

/** Puts stock back (e.g. when a paid order is cancelled). Deleted products are skipped. */
export async function restoreStock(client, items) {
  for (const item of [...items].sort(byProductId)) {
    if (!item.product_id) continue;
    await client.query('update public.products set stock = stock + $2 where id = $1', [item.product_id, item.quantity]);
  }
}
