import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planPaymentIncentives,
  incentivesNeedShopifyEdit,
  orderHasCodFee,
  orderHasOnlineDiscount,
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
      current_total_additional_fees_set: { shop_money: { amount: '20.0' } },
    };
    assert.equal(orderHasCodFee(payload), true);
    assert.equal(incentivesNeedShopifyEdit(planPaymentIncentives(payload, 'cod')), false);
  });

  it('COD: add EGP 20 and strip the online 5% code', () => {
    const plan = planPaymentIncentives(codOrder, 'cod');
    assert.equal(plan.addCodFee, true);
    assert.equal(plan.removeOnlineDiscount, true);
    assert.equal(plan.removeCodFee, false);
    assert.equal(incentivesNeedShopifyEdit(plan), true);
  });

  it('online: drop a leftover COD fee and add 5% when missing', () => {
    const unpaidOnline = {
      financial_status: 'paid',
      line_items: [
        { sku: 'GMC-2-1007', title: 'Boot' },
        { sku: 'GAZELLE-COD-FEE', title: 'رسوم الدفع عند الاستلام' },
      ],
    };
    const plan = planPaymentIncentives(unpaidOnline, 'online');
    assert.equal(plan.removeCodFee, true);
    assert.equal(plan.addCodFee, false);
    assert.equal(plan.addOnlineDiscount, true);
  });

  it('online already 5% off and no fee needs no edit', () => {
    const payload = {
      financial_status: 'paid',
      discount_codes: [{ code: 'ONLINE5' }],
      line_items: [{ sku: 'GMC-2-1007', title: 'Boot' }],
    };
    const plan = planPaymentIncentives(payload, 'online');
    assert.equal(incentivesNeedShopifyEdit(plan), false);
  });

  it('COD already with fee and no discount needs no edit', () => {
    const payload = {
      financial_status: 'pending',
      line_items: [{ sku: 'GAZELLE-COD-FEE', title: 'رسوم الدفع عند الاستلام' }],
    };
    const plan = planPaymentIncentives(payload, 'cod');
    assert.equal(incentivesNeedShopifyEdit(plan), false);
  });
});
