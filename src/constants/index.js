export const USER_ROLES = ['admin', 'orders_manager', 'stock_manager'];

export const ORDER_STATUSES = [
  'pending_verification',
  'verified_ready_for_shipping',
  'picked_up_by_bosta',
  'in_transit',
  'delivered',
  'failed_delivery',
  'returning_to_origin',
  'returned_to_stock',
  'cancelled',
];

export const TERMINAL_ORDER_STATUSES = ['delivered', 'returned_to_stock', 'cancelled'];

export const LEDGER_TYPES = [
  'on_hold_reserve',
  'on_hold_release',
  'real_stock_decrement',
  'real_stock_increment_manual',
  'real_stock_increment_return',
  'online_stock_increment_api',
];

export const STATUS_SOURCES = ['shopify_webhook', 'bosta_webhook', 'user_action', 'system'];

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

export const JOB_NAMES = {
  PROCESS_SHOPIFY_WEBHOOK: 'process-shopify-webhook',
  PROCESS_BOSTA_WEBHOOK: 'process-bosta-webhook',
  SHOPIFY_OUTBOUND_INVENTORY: 'shopify-outbound-inventory',
  SHOPIFY_CATALOG_SYNC: 'shopify-catalog-sync',
  BOSTA_CREATE_SHIPMENT: 'bosta-create-shipment',
  BOSTA_POLLING_FALLBACK: 'bosta-polling-fallback',
};
