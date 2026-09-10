import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCustomerRefundAmount } from '../utils/computeCustomerRefundAmount.js';

describe('computeCustomerRefundAmount', () => {
  it('uses stored refundAmount when present', () => {
    assert.equal(
      computeCustomerRefundAmount({ refundAmount: 1290, isReturnOrder: true }),
      1290
    );
  });

  it('uses exchange credit for exchange orders', () => {
    assert.equal(
      computeCustomerRefundAmount({
        isExchangeOrder: true,
        exchangeCreditAmount: 200,
        refundAmount: 0,
      }),
      200
    );
  });

  it('sums collect line unit prices for returns', () => {
    assert.equal(
      computeCustomerRefundAmount({
        isReturnOrder: true,
        refundAmount: 0,
        bostaReturnItems: [
          { variantId: 'a', sku: 'SKU-A', quantity: 1, unitSellingPrice: 1995 },
          { variantId: 'b', sku: 'SKU-B', quantity: 1, unitSellingPrice: 1995 },
        ],
      }),
      3990
    );
  });

  it('falls back to prior order items by sku when collect has no prices', () => {
    assert.equal(
      computeCustomerRefundAmount(
        {
          isReturnOrder: true,
          refundAmount: 0,
          bostaReturnItems: [
            { variantId: 'x', sku: 'GW1001-7004', quantity: 1 },
            { variantId: 'y', sku: 'GW1003-7005', quantity: 1 },
          ],
        },
        {
          totalSellingPrice: 3990,
          items: [
            { variantId: 'a', sku: 'GW1001-7004', quantity: 1, unitSellingPrice: 1995 },
            { variantId: 'b', sku: 'GW1003-7005', quantity: 1, unitSellingPrice: 1995 },
          ],
        }
      ),
      3990
    );
  });

  it('falls back to prior total when lines cannot be matched', () => {
    assert.equal(
      computeCustomerRefundAmount(
        {
          isReturnOrder: true,
          refundAmount: 0,
          bostaReturnItems: [{ variantId: 'missing', sku: 'UNKNOWN', quantity: 1 }],
        },
        { totalSellingPrice: 1290, items: [] }
      ),
      1290
    );
  });
});
