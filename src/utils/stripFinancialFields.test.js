import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { stripFinancialFields } from './stripFinancialFields.js';

test('admin responses are untouched', () => {
  const body = { data: { totalCogsSnapshot: 400 } };
  assert.equal(stripFinancialFields(body, 'admin'), body);
});

test('strips cost fields at any depth for non-admins', () => {
  const body = {
    data: {
      orders: [
        {
          totalCogsSnapshot: 400,
          totalSellingPrice: 900,
          items: [{ sku: 'A', unitCogs: 200, variantId: { sku: 'A', cogs: 200, realStock: 3 } }],
        },
      ],
      total: 1,
    },
  };
  const out = stripFinancialFields(body, 'orders_manager');
  const order = out.data.orders[0];
  assert.equal(order.totalCogsSnapshot, undefined);
  assert.equal(order.totalSellingPrice, 900);
  assert.equal(order.items[0].unitCogs, undefined);
  assert.equal(order.items[0].variantId.cogs, undefined);
  assert.equal(order.items[0].variantId.realStock, 3);
  assert.equal(out.data.total, 1);
  assert.equal(body.data.orders[0].totalCogsSnapshot, 400);
});

test('keeps ObjectId and Date values intact and handles mongoose documents', () => {
  const Model = mongoose.models.StripTest
    || mongoose.model('StripTest', new mongoose.Schema({ cogs: Number, sku: String, at: Date }));
  const doc = new Model({ cogs: 50, sku: 'B', at: new Date('2026-01-01T00:00:00Z') });
  const out = stripFinancialFields({ data: doc }, 'stock_manager');
  assert.equal(out.data.cogs, undefined);
  assert.equal(out.data.sku, 'B');
  assert.ok(out.data._id instanceof mongoose.Types.ObjectId);
  assert.ok(out.data.at instanceof Date);
});
