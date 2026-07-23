export const USER_ROLES = ['admin', 'orders_manager', 'stock_manager'];

export const ORDER_STATUSES = [
  'pending_verification',
  'verified_ready_for_shipping',
  'picked_up_by_bosta',
  'in_transit',
  'delivered',
  'failed_delivery',
  'returning_to_origin',
  'returned_awaiting_receipt',
  'returned_to_stock',
  'cancelled',
];

export const TERMINAL_ORDER_STATUSES = ['returned_to_stock', 'cancelled'];

export const LEDGER_TYPES = [
  'on_hold_reserve',
  'on_hold_release',
  'real_stock_decrement',
  'real_stock_increment_manual',
  'real_stock_increment_return',
  'online_stock_increment_api',
];

export const STATUS_SOURCES = ['shopify_webhook', 'shopify_import', 'bosta_webhook', 'user_action', 'system'];

export const RISK_FLAGS = ['none', 'watch', 'high_risk', 'vip'];

export const CANCELLATION_REASONS = [
  'customer_changed_mind',
  'duplicate_order',
  'out_of_stock',
  'fraud_suspected',
  'other',
];

export const VERIFICATION_OUTCOMES = [
  'confirmed',
  'no_response',
  'customer_requested_changes',
  'customer_cancelled',
];

export const SHOPIFY_SYNC_STATUSES = ['pending', 'synced', 'failed'];

export const ORDER_SOURCES = ['shopify', 'manual'];

export const MANUAL_ORDER_SOURCES = [
  'instagram',
  'facebook',
  'whatsapp',
  'phone',
  'website',
  'other',
];

export const SHIPPING_METHODS = ['bosta', 'local_shipping', 'pickup'];

/**
 * OMS order cutover (Cairo calendar day).
 * Order lists + order-based dashboard tiles only include orders placed on/after this day.
 * Money KPIs (COD, Paymob, Bosta returns) keep the admin-selected full date range.
 */
export const ORDERS_PLACED_FROM_YMD = '2026-07-20';

export const JOB_NAMES = {
  PROCESS_SHOPIFY_WEBHOOK: 'process-shopify-webhook',
  PROCESS_BOSTA_WEBHOOK: 'process-bosta-webhook',
  SHOPIFY_OUTBOUND_INVENTORY: 'shopify-outbound-inventory',
  SHOPIFY_CATALOG_SYNC: 'shopify-catalog-sync',
  BOSTA_CREATE_SHIPMENT: 'bosta-create-shipment',
  BOSTA_POLLING_FALLBACK: 'bosta-polling-fallback',
  BOSTA_ORDER_STATES_SYNC: 'bosta-order-states-sync',
  BOSTA_RETURNS_SYNC: 'bosta-returns-sync',
  CHECK_RESTOCK_NEEDED: 'check-restock-needed',
  CHECK_SLOW_MOVERS: 'check-slow-movers',
  SHOPIFY_ORDERS_SYNC: 'shopify-orders-sync',
  ORDER_DELAY_CALLBACKS: 'order-delay-callbacks',
};

export const PO_STATUSES = [
  'draft',
  'sent',
  'confirmed',
  'in_production',
  'shipped',
  'received',
  'cancelled',
];

export const OPEN_PO_STATUSES = ['draft', 'sent', 'confirmed', 'in_production', 'shipped'];

/** Min received POs before showing factory avg lead time (estimated used until then). */
export const FACTORY_AVG_LEAD_TIME_MIN_SAMPLES = 3;

export const DEFAULT_FACTORIES = [
  { name: 'Joki', leadTimeDays: 10 },
  { name: 'Salah', leadTimeDays: 20 },
  { name: 'Negma', leadTimeDays: 10 },
  { name: 'Otex', leadTimeDays: 7 },
  { name: 'Taema', leadTimeDays: 7 },
];

export const GL_CATEGORIES = ['asset', 'revenue', 'cogs', 'expense', 'liability', 'equity'];

export const JOURNAL_SOURCES = ['manual', 'auto_order', 'auto_delivery'];

export const LEAVE_TYPES = ['annual', 'sick', 'unpaid', 'emergency'];

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected'];

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'half_day'];

export const SALARY_TYPES = ['monthly', 'hourly'];

export const HR_DEPARTMENTS = ['operations', 'warehouse', 'admin', 'sales', 'other'];
