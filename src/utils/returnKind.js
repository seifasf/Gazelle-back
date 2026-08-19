/**
 * Same rules as the frontend return queues.
 * - exchange: exchange order
 * - refund: refund pickup (CRP) or package returned after a successful delivery
 * - refused: never delivered — customer refused / failed attempt (RTO)
 */
export function classifyReturnKind(order) {
  if (!order) return 'refused';
  if (order.isExchangeOrder) return 'exchange';
  if (order.isReturnOrder || order.deliveredAt) return 'refund';
  return 'refused';
}
