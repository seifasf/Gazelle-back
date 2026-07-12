import ExcelJS from 'exceljs';
import Order from '../models/Order.js';
import '../models/Customer.js';
import '../models/User.js';
import { workbookBuffer, styleHeaderRow } from '../utils/excelExport.js';

const WAREHOUSE_STATUSES = ['pending_verification', 'verified_ready_for_shipping'];

function dayKey(date) {
  if (!date) return 'unknown';
  return new Date(date).toISOString().slice(0, 10);
}

function queueDate(order) {
  if (order.internalStatus === 'verified_ready_for_shipping') {
    return order.verifiedAt || order.placedAt;
  }
  return order.placedAt;
}

function daysWaiting(fromDate) {
  if (!fromDate) return null;
  const ms = Date.now() - new Date(fromDate).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function statusLabel(status) {
  if (status === 'verified_ready_for_shipping') return 'Ready to ship (scan & pack)';
  if (status === 'pending_verification') return 'Pending verification';
  return status;
}

function flattenOrder(order) {
  const qDate = queueDate(order);
  const skus = (order.items || []).map((i) => `${i.sku}×${i.quantity}`).join(', ');
  const units = (order.items || []).reduce((s, i) => s + i.quantity, 0);
  const customer = order.customerId;
  return {
    queueDay: dayKey(qDate),
    queueAt: qDate,
    orderId: String(order._id),
    orderRef: order.shopifyOrderId,
    status: order.internalStatus,
    statusLabel: statusLabel(order.internalStatus),
    customerName: customer?.fullName || order.shippingAddress?.fullName || '—',
    phone: customer?.phone || order.shippingAddress?.phone || '',
    city: order.shippingAddress?.city || '',
    skus,
    units,
    valueEgp: order.totalSellingPrice ?? 0,
    paymentMethod: order.paymentMethod === 'online' ? 'Online' : 'COD',
    shippingMethod: order.shippingMethod || '',
    daysWaiting: daysWaiting(qDate),
    assignedStockManager: order.assignedStockManagerId?.name || '',
    placedAt: order.placedAt,
    verifiedAt: order.verifiedAt,
    isCreatorOrder: Boolean(order.isCreatorOrder),
  };
}

export async function getWarehouseBacklog({ from, to } = {}) {
  const orders = await Order.find({ internalStatus: { $in: WAREHOUSE_STATUSES } })
    .populate('customerId', 'fullName phone')
    .populate('assignedStockManagerId', 'name')
    .sort({ verifiedAt: 1, placedAt: 1 })
    .lean();

  let rows = orders.map(flattenOrder);

  if (from || to) {
    rows = rows.filter((r) => {
      const d = r.queueDay;
      if (d === 'unknown') return false;
      if (from && d < String(from).slice(0, 10)) return false;
      if (to && d > String(to).slice(0, 10)) return false;
      return true;
    });
  }

  const byDay = {};
  for (const row of rows) {
    const key = row.queueDay;
    if (!byDay[key]) {
      byDay[key] = {
        day: key,
        orderCount: 0,
        pendingVerification: 0,
        readyToShip: 0,
        units: 0,
        valueEgp: 0,
        oldestDaysWaiting: 0,
      };
    }
    const bucket = byDay[key];
    bucket.orderCount += 1;
    bucket.units += row.units;
    bucket.valueEgp += row.valueEgp;
    if (row.status === 'pending_verification') bucket.pendingVerification += 1;
    if (row.status === 'verified_ready_for_shipping') bucket.readyToShip += 1;
    bucket.oldestDaysWaiting = Math.max(bucket.oldestDaysWaiting, row.daysWaiting ?? 0);
  }

  const dailySummary = Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day));
  rows.sort((a, b) => {
    const dayCmp = b.queueDay.localeCompare(a.queueDay);
    if (dayCmp !== 0) return dayCmp;
    return (b.daysWaiting ?? 0) - (a.daysWaiting ?? 0);
  });

  const readyToShip = rows.filter((r) => r.status === 'verified_ready_for_shipping');
  const pendingVerification = rows.filter((r) => r.status === 'pending_verification');

  return {
    generatedAt: new Date().toISOString(),
    range: { from: from || null, to: to || null },
    totals: {
      orders: rows.length,
      readyToShip: readyToShip.length,
      pendingVerification: pendingVerification.length,
      units: rows.reduce((s, r) => s + r.units, 0),
      valueEgp: rows.reduce((s, r) => s + r.valueEgp, 0),
      oldestDaysWaiting: rows.reduce((m, r) => Math.max(m, r.daysWaiting ?? 0), 0),
    },
    dailySummary,
    orders: rows,
  };
}

export async function exportWarehouseBacklogExcel(query = {}) {
  const data = await getWarehouseBacklog(query);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Gazelle OMS';
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet('Daily summary');
  summarySheet.columns = [
    { header: 'Queue day', key: 'day', width: 14 },
    { header: 'Orders waiting', key: 'orderCount', width: 16 },
    { header: 'Ready to ship', key: 'readyToShip', width: 14 },
    { header: 'Pending verify', key: 'pendingVerification', width: 16 },
    { header: 'Units', key: 'units', width: 10 },
    { header: 'Value (EGP)', key: 'valueEgp', width: 14 },
    { header: 'Oldest wait (days)', key: 'oldestDaysWaiting', width: 18 },
  ];
  for (const row of data.dailySummary) summarySheet.addRow(row);
  styleHeaderRow(summarySheet);

  const ordersSheet = workbook.addWorksheet('Orders in warehouse');
  ordersSheet.columns = [
    { header: 'Queue day', key: 'queueDay', width: 12 },
    { header: 'Order #', key: 'orderRef', width: 16 },
    { header: 'Status', key: 'statusLabel', width: 28 },
    { header: 'Customer', key: 'customerName', width: 22 },
    { header: 'Phone', key: 'phone', width: 14 },
    { header: 'City', key: 'city', width: 14 },
    { header: 'SKUs', key: 'skus', width: 36 },
    { header: 'Units', key: 'units', width: 8 },
    { header: 'Value (EGP)', key: 'valueEgp', width: 12 },
    { header: 'Payment', key: 'paymentMethod', width: 10 },
    { header: 'Shipping', key: 'shippingMethod', width: 14 },
    { header: 'Days waiting', key: 'daysWaiting', width: 14 },
    { header: 'Verified at', key: 'verifiedAt', width: 20 },
    { header: 'Placed at', key: 'placedAt', width: 20 },
    { header: 'Creator', key: 'isCreatorOrder', width: 10 },
  ];
  for (const row of data.orders) {
    ordersSheet.addRow({
      ...row,
      verifiedAt: row.verifiedAt ? new Date(row.verifiedAt).toISOString() : '',
      placedAt: row.placedAt ? new Date(row.placedAt).toISOString() : '',
      isCreatorOrder: row.isCreatorOrder ? 'Yes' : '',
    });
  }
  styleHeaderRow(ordersSheet);

  const buffer = await workbookBuffer(workbook);
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `warehouse-backlog-${stamp}.xlsx`, data };
}

export default { getWarehouseBacklog, exportWarehouseBacklogExcel };
