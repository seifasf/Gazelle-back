import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planPaymentIncentives,
  incentivesNeedShopifyEdit,
  orderHasCodFee,
  orderHasOnlineDiscount,
  shopifyMerchandiseTotal,
} from './shopifyPaymentIncentives.js';

describe('Shopify payment incentives plan', () => {
  const codOrder = {
    financial_status: 'pending',
    discount_codes: [{ code: 'ONLINE5' }],
    line_items: [{ sku: 'GMC-2-1007', title: 'Boot', price: '1395' }],
  };

  const onlineWithFee = {
    financial_status: 'paid',
    discount_codes: [{ code: 'ONLINE5' }],
    line_items: [
      { sku: 'GMC-2-1007', title: 'Boot' },
      { sku: 'GAZELLE-COD-FEE', title: 'رسوم الدفع عند الاستلام' },
    ],
  };

  it('flags the 5% code and the COD fee SKU', () => {
    assert.equal(orderHasOnlineDiscount(codOrder), true);
    assert.equal(orderHasCodFee(codOrder), false);
    assert.equal(orderHasCodFee(onlineWithFee), true);
  });

  it('treats a Releasit additional fee as the COD fee', () => {
    const payload = {
      financial_status: 'pending',
      line_items: [{ sku: 'GMC-2-1007', title: 'Boot' }],
      current_total_additional_fees_set: { shop_money: { amount: '25.0' } },
    };
    assert.equal(orderHasCodFee(payload), true);
    assert.equal(planPaymentIncentives(payload, 'cod').addCodFee, false);
  });

  it('never edits Shopify for COD 25 or ONLINE5', () => {
    const plan = planPaymentIncentives(codOrder, 'cod');
    assert.equal(plan.addCodFee, false);
    assert.equal(plan.removeOnlineDiscount, false);
    assert.equal(plan.removeCodFee, false);
    assert.equal(incentivesNeedShopifyEdit(plan), false);
  });

  it('never adds 5% or a COD line on Shopify for online orders', () => {
    const unpaidOnline = {
      financial_status: 'paid',
      line_items: [
        { sku: 'GMC-2-1007', title: 'Boot' },
        { sku: 'GAZELLE-COD-FEE', title: 'رسوم الدفع عند الاستلام' },
      ],
    };
    const plan = planPaymentIncentives(unpaidOnline, 'online');
    assert.equal(plan.removeCodFee, false);
    assert.equal(plan.addCodFee, false);
    assert.equal(plan.addOnlineDiscount, false);
    assert.equal(incentivesNeedShopifyEdit(plan), false);
  });

  it('online already 5% off needs no Shopify edit', () => {
    const payload = {
      financial_status: 'paid',
      discount_codes: [{ code: 'ONLINE5' }],
      line_items: [{ sku: 'GMC-2-1007', title: 'Boot' }],
    };
    const plan = planPaymentIncentives(payload, 'online');
    assert.equal(incentivesNeedShopifyEdit(plan), false);
  });

  it('COD never writes the fee to Shopify', () => {
    const payload = {
      financial_status: 'pending',
      line_items: [{ sku: 'GMC-2-1007', title: 'Boot' }],
    };
    const plan = planPaymentIncentives(payload, 'cod');
    assert.equal(plan.addCodFee, false);
    assert.equal(incentivesNeedShopifyEdit(plan), false);
  });

  it('strips a Shopify COD fee from OMS merchandise', () => {
    const total = shopifyMerchandiseTotal(
      {
        total_price: '1115.00',
        line_items: [
          { sku: 'GMC-2-1007', title: 'Boot' },
          { sku: 'GAZELLE-COD-FEE', title: 'رسوم الدفع عند الاستلام' },
        ],
      },
      95
    );
    assert.equal(total, 995);
  });
});
