import asyncHandler from '../utils/asyncHandler.js';
import {
  cancelUnpaidOrder,
  createOrder,
  getDashboardStats,
  getOrderById,
  listOrdersForAdmin,
  listOrdersForUser,
  updateOrderStatus,
} from '../services/orderService.js';
import { refundOrder } from '../services/paymentService.js';

/** POST /api/orders — creates a pending order priced from the database. */
export const createOrderHandler = asyncHandler(async (req, res) => {
  const order = await createOrder(req.user, req.body);
  res.status(201).json({ success: true, message: 'Order created. Complete payment to confirm it.', order });
});

/** GET /api/orders/my-orders */
export const getMyOrders = asyncHandler(async (req, res) => {
  const result = await listOrdersForUser(req.user.id, req.query);
  res.json({ success: true, ...result });
});

/** GET /api/orders/:id — customers see only their own orders; admins see any. */
export const getOrder = asyncHandler(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const order = await getOrderById(req.params.id, isAdmin ? { admin: true } : { userId: req.user.id });
  res.json({ success: true, order });
});

/** POST /api/orders/:id/cancel — customer cancels an unpaid order. */
export const cancelMyOrder = asyncHandler(async (req, res) => {
  const order = await cancelUnpaidOrder(req.params.id, req.user.id);
  res.json({ success: true, message: 'Order cancelled.', order });
});

/** GET /api/admin/orders */
export const getAdminOrders = asyncHandler(async (req, res) => {
  const result = await listOrdersForAdmin(req.query);
  res.json({ success: true, ...result });
});

/** GET /api/admin/orders/:id */
export const getAdminOrder = asyncHandler(async (req, res) => {
  const order = await getOrderById(req.params.id, { admin: true });
  res.json({ success: true, order });
});

/** PUT /api/admin/orders/:id/status */
export const updateOrderStatusHandler = asyncHandler(async (req, res) => {
  const { status, note, refund } = req.body;
  let { order, wasPaid } = await updateOrderStatus(req.params.id, { status, note }, req.user.id);
  let message = `Order marked as ${status}.`;

  if (status === 'cancelled' && wasPaid && refund) {
    const result = await refundOrder(order.id, `Order cancelled by admin${note ? `: ${note}` : ''}`);
    message = result.refunded ? 'Order cancelled and refund initiated.' : `Order cancelled. ${result.message}`;
    order = await getOrderById(order.id, { admin: true });
  } else if (status === 'cancelled' && wasPaid) {
    message = 'Order cancelled and stock returned. The payment was not refunded.';
  }

  res.json({ success: true, message, order });
});

/** GET /api/admin/stats */
export const getStats = asyncHandler(async (req, res) => {
  const stats = await getDashboardStats();
  res.json({ success: true, stats });
});
