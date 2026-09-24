import env from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import AppError from '../utils/AppError.js';
import { escapeLike, isUuid, paginationMeta, roundMoney } from '../utils/helpers.js';
import { restoreStock } from './inventoryService.js';

export const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded'];

/** The forward-only fulfilment workflow admins can move an order through. */
export const ORDER_TRANSITIONS = {
  pending: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function toOrderDto(row, { items = [], history = [], payments, admin = false } = {}) {
  const dto = {
    id: row.id,
    orderNumber: row.order_number,
    customer: row.user_id
      ? { id: row.user_id, name: row.customer_name ?? row.shipping_address?.fullName, email: row.customer_email }
      : null,
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      name: i.name,
      image: i.image,
      price: i.price,
      quantity: i.quantity,
      subtotal: i.subtotal,
    })),
    itemCount: row.item_count ?? items.reduce((sum, i) => sum + i.quantity, 0),
    shippingAddress: row.shipping_address,
    paymentMethod: row.payment_method,
    paymentReference: row.payment_reference,
    paymentStatus: row.payment_status,
    orderStatus: row.order_status,
    subtotal: row.subtotal,
    shippingFee: row.shipping_fee,
    totalAmount: row.total_amount,
    currency: row.currency.trim(),
    paidAt: row.paid_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    statusHistory: history.map((h) => ({ status: h.status, note: h.note, createdAt: h.created_at })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (admin) {
    dto.requiresAttention = row.requires_attention;
    dto.adminNote = row.admin_note;
    dto.inventoryCommitted = row.inventory_committed;
    if (payments) {
      dto.payments = payments.map((p) => ({
        id: p.id,
        provider: p.provider,
        reference: p.reference,
        transactionId: p.provider_transaction_id,
        amount: p.amount,
        amountPaid: p.amount_paid,
        currency: p.currency.trim(),
        status: p.status,
        channel: p.channel,
        gatewayResponse: p.gateway_response,
        note: p.note,
        paidAt: p.paid_at,
        verifiedAt: p.verified_at,
        createdAt: p.created_at,
      }));
    }
  }
  return dto;
}

const ORDER_SELECT = `
  select o.*, pr.name as customer_name, pr.email as customer_email,
         (select coalesce(sum(quantity), 0)::int from public.order_items oi where oi.order_id = o.id) as item_count
    from public.orders o
    left join public.profiles pr on pr.id = o.user_id`;

export async function addHistory(client, orderId, status, note, changedBy = null) {
  await client.query(
    'insert into public.order_status_history (order_id, status, note, changed_by) values ($1, $2, $3, $4)',
    [orderId, status, note ?? null, changedBy],
  );
}

/**
 * Creates a pending order. Prices and totals come from the database only; the
 * client sends nothing but product ids and quantities.
 */
export async function createOrder(user, { items, shippingAddress, paymentMethod }) {
  const quantities = new Map();
  for (const { productId, quantity } of items) {
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }

  const { rows: products } = await query(
    'select id, name, price, stock, images, is_active from public.products where id = any($1::uuid[])',
    [[...quantities.keys()]],
  );
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  for (const [productId, quantity] of quantities) {
    const product = byId.get(productId);
    if (!product || !product.is_active) {
      throw AppError.badRequest('One of the products in your cart is no longer available. Please review your cart.');
    }
    if (product.stock <= 0) throw AppError.conflict(`"${product.name}" is out of stock.`);
    if (quantity > product.stock) {
      throw AppError.conflict(`Only ${product.stock} of "${product.name}" left in stock.`);
    }
    lines.push({
      productId,
      name: product.name,
      image: product.images?.[0]?.url ?? null,
      price: product.price,
      quantity,
      subtotal: roundMoney(product.price * quantity),
    });
  }

  const subtotal = roundMoney(lines.reduce((sum, l) => sum + l.subtotal, 0));
  const shippingFee = roundMoney(env.SHIPPING_FEE);
  const totalAmount = roundMoney(subtotal + shippingFee);

  const orderId = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into public.orders
         (user_id, shipping_address, payment_method, subtotal, shipping_fee, total_amount, currency)
       values ($1, $2::jsonb, $3, $4, $5, $6, $7)
       returning id`,
      [user.id, JSON.stringify(shippingAddress), paymentMethod, subtotal, shippingFee, totalAmount, env.CURRENCY],
    );
    const id = rows[0].id;
    for (const line of lines) {
      await client.query(
        `insert into public.order_items (order_id, product_id, name, image, price, quantity, subtotal)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, line.productId, line.name, line.image, line.price, line.quantity, line.subtotal],
      );
    }
    await addHistory(client, id, 'pending', 'Order placed, awaiting payment', user.id);
    return id;
  });

  return getOrderById(orderId, { userId: user.id });
}

/** Loads a full order. Pass userId to restrict to that customer's orders. */
export async function getOrderById(id, { userId, admin = false } = {}) {
  if (!isUuid(id)) throw AppError.notFound('Order not found.');
  const params = [id];
  let filter = 'where o.id = $1';
  if (userId) {
    params.push(userId);
    filter += ' and o.user_id = $2';
  }
  const { rows } = await query(`${ORDER_SELECT} ${filter}`, params);
  if (!rows[0]) throw AppError.notFound('Order not found.');

  const [items, history, payments] = await Promise.all([
    query('select * from public.order_items where order_id = $1 order by name', [id]),
    query('select * from public.order_status_history where order_id = $1 order by created_at, id', [id]),
    admin ? query('select * from public.payments where order_id = $1 order by created_at desc', [id]) : null,
  ]);

  return toOrderDto(rows[0], { items: items.rows, history: history.rows, payments: payments?.rows, admin });
}

export async function listOrdersForUser(userId, { page, limit }) {
  const [{ rows }, count] = await Promise.all([
    query(`${ORDER_SELECT} where o.user_id = $1 order by o.created_at desc limit $2 offset $3`, [
      userId,
      limit,
      (page - 1) * limit,
    ]),
    query('select count(*)::int as total from public.orders where user_id = $1', [userId]),
  ]);

  // First item image/name per order for the order-history list.
  const ids = rows.map((r) => r.id);
  const previews = ids.length
    ? (
        await query(
          `select distinct on (order_id) order_id, name, image
             from public.order_items where order_id = any($1::uuid[]) order by order_id, name`,
          [ids],
        )
      ).rows
    : [];
  const previewById = new Map(previews.map((p) => [p.order_id, p]));

  return {
    orders: rows.map((r) => ({ ...toOrderDto(r), preview: previewById.get(r.id) ?? null })),
    pagination: paginationMeta(page, limit, count.rows[0].total),
  };
}

export async function listOrdersForAdmin({ page, limit, status, search }) {
  const where = [];
  const params = [];
  if (status === 'attention') {
    where.push('o.requires_attention');
  } else if (status) {
    params.push(status);
    const col = PAYMENT_STATUSES.includes(status) && !ORDER_STATUSES.includes(status) ? 'payment_status' : 'order_status';
    where.push(`o.${col} = $${params.length}`);
  }
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    where.push(
      `(o.order_number ilike $${params.length} or pr.email ilike $${params.length} or pr.name ilike $${params.length}
        or o.shipping_address->>'fullName' ilike $${params.length} or o.payment_reference ilike $${params.length})`,
    );
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';

  const [{ rows }, count] = await Promise.all([
    query(`${ORDER_SELECT} ${whereSql} order by o.created_at desc limit $${params.length + 1} offset $${params.length + 2}`, [
      ...params,
      limit,
      (page - 1) * limit,
    ]),
    query(
      `select count(*)::int as total from public.orders o left join public.profiles pr on pr.id = o.user_id ${whereSql}`,
      params,
    ),
  ]);

  return {
    orders: rows.map((r) => toOrderDto(r, { admin: true })),
    pagination: paginationMeta(page, limit, count.rows[0].total),
  };
}

/**
 * Admin fulfilment update. Enforces pending -> processing -> shipped -> delivered,
 * with cancellation allowed before shipping. Cancelling a paid order returns its
 * stock. Returns { order, refund } where refund describes a requested refund.
 */
export async function updateOrderStatus(orderId, { status, note }, adminId) {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('select * from public.orders where id = $1 for update', [orderId]);
    const order = rows[0];
    if (!order) throw AppError.notFound('Order not found.');

    if (order.order_status === status) throw AppError.badRequest(`Order is already ${status}.`);
    if (!ORDER_TRANSITIONS[order.order_status].includes(status)) {
      throw AppError.badRequest(`An order that is ${order.order_status} cannot be moved to ${status}.`);
    }
    if (status !== 'cancelled' && order.payment_status !== 'paid') {
      throw AppError.badRequest('Only paid orders can be processed, shipped or delivered.');
    }

    const sets = ['order_status = $2'];
    if (status === 'delivered') sets.push('delivered_at = now()');
    if (status === 'cancelled') sets.push('cancelled_at = now()');

    if (status === 'cancelled' && order.inventory_committed) {
      const items = await client.query('select product_id, name, quantity from public.order_items where order_id = $1', [
        orderId,
      ]);
      await restoreStock(client, items.rows);
      sets.push('inventory_committed = false');
    }

    await client.query(`update public.orders set ${sets.join(', ')} where id = $1`, [orderId, status]);
    await addHistory(client, orderId, status, note, adminId);
    return { wasPaid: order.payment_status === 'paid' };
  });

  return { order: await getOrderById(orderId, { admin: true }), wasPaid: result.wasPaid };
}

/** Customers may cancel their own order only while it is unpaid. */
export async function cancelUnpaidOrder(orderId, userId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query('select * from public.orders where id = $1 and user_id = $2 for update', [
      orderId,
      userId,
    ]);
    const order = rows[0];
    if (!order) throw AppError.notFound('Order not found.');
    if (order.order_status !== 'pending' || !['pending', 'failed'].includes(order.payment_status)) {
      throw AppError.badRequest('This order can no longer be cancelled. Please contact support.');
    }
    await client.query("update public.orders set order_status = 'cancelled', cancelled_at = now() where id = $1", [orderId]);
    await addHistory(client, orderId, 'cancelled', 'Cancelled by customer', userId);
  });
  return getOrderById(orderId, { userId });
}

export async function getDashboardStats() {
  const [products, orders, recent, lowStock] = await Promise.all([
    query(`select count(*)::int as total,
                  count(*) filter (where stock = 0)::int as out_of_stock,
                  count(*) filter (where stock > 0 and stock <= $1)::int as low_stock
             from public.products`, [env.LOW_STOCK_THRESHOLD]),
    query(`select count(*)::int as total,
                  count(*) filter (where order_status = 'pending')::int as pending,
                  count(*) filter (where payment_status = 'paid')::int as paid,
                  count(*) filter (where order_status = 'delivered')::int as completed,
                  count(*) filter (where requires_attention)::int as needs_attention,
                  coalesce(sum(total_amount) filter (where payment_status = 'paid'), 0) as revenue
             from public.orders`),
    query(`${ORDER_SELECT} order by o.created_at desc limit 8`),
    query(`select id, name, slug, stock, images from public.products
            where stock <= $1 order by stock asc, name limit 8`, [env.LOW_STOCK_THRESHOLD]),
  ]);

  const p = products.rows[0];
  const o = orders.rows[0];
  return {
    totalProducts: p.total,
    outOfStockProducts: p.out_of_stock,
    lowStockProducts: p.low_stock,
    totalOrders: o.total,
    pendingOrders: o.pending,
    paidOrders: o.paid,
    completedOrders: o.completed,
    ordersNeedingAttention: o.needs_attention,
    totalRevenue: o.revenue,
    currency: env.CURRENCY,
    lowStockThreshold: env.LOW_STOCK_THRESHOLD,
    recentOrders: recent.rows.map((r) => toOrderDto(r, { admin: true })),
    lowStock: lowStock.rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, stock: r.stock, image: r.images?.[0]?.url ?? null })),
  };
}
