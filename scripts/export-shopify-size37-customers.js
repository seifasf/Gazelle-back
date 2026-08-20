#!/usr/bin/env node
/**
 * Standalone export — reads Shopify orders only; does NOT touch OMS/MongoDB.
 * Output: Desktop Excel with name + phone for customers who ordered size 37.
 *
 * Usage: node scripts/export-shopify-size37-customers.js [targetCount]
 */
import 'dotenv/config';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import ExcelJS from 'exceljs';

const TARGET = Math.min(5000, Math.max(1, Number(process.argv[2]) || 2000));
const OUT_PATH = join(
  '/Users/mac/Desktop',
  `shopify-size-37-customers-${new Date().toISOString().slice(0, 10)}.xlsx`
);

const SHOP = String(process.env.SHOPIFY_SHOP_DOMAIN || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .split('/')[0];
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function shopifyGet(pathOrUrl) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `https://${SHOP}/admin/api/${API_VERSION}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.errors || data.error || res.statusText);
  return { data, nextUrl: parseNextLink(res.headers.get('link')) };
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('20') && digits.length >= 12) return `0${digits.slice(2, 12)}`;
  if (digits.length >= 10) return digits.slice(-11).replace(/^0?/, '0');
  return digits;
}

function lineIsSize37(line) {
  const sku = String(line.sku || '').toUpperCase();
  const variantTitle = String(line.variant_title || '');
  const title = String(line.title || '');

  if (/(^|[-_/])37($|[-_/])/.test(sku) || sku.endsWith('-37') || sku.endsWith('_37')) return true;
  if (/\b37\b/.test(variantTitle) && /\/\s*37\b|size\s*37|\b37\s*$/i.test(variantTitle)) return true;
  if (/\b37\b/.test(variantTitle) && variantTitle.split('/').pop()?.trim() === '37') return true;

  for (const prop of line.properties || []) {
    const n = String(prop.name || '').toLowerCase();
    const v = String(prop.value || '').trim();
    if ((n.includes('size') || n === 'مقاس') && v === '37') return true;
  }

  const options = [line.option1, line.option2, line.option3].filter(Boolean).map(String);
  if (options.some((o) => o.trim() === '37')) return true;

  return false;
}

function extractContact(order) {
  const ship = order.shipping_address || {};
  const bill = order.billing_address || {};
  const cust = order.customer || {};

  const name =
    [ship.first_name, ship.last_name].filter(Boolean).join(' ').trim() ||
    [bill.first_name, bill.last_name].filter(Boolean).join(' ').trim() ||
    [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() ||
    order.email ||
    '';

  const phone =
    ship.phone ||
    bill.phone ||
    cust.phone ||
    cust.default_address?.phone ||
    '';

  return { name: name.trim(), phone: normalizePhone(phone) };
}

async function main() {
  if (!SHOP || !TOKEN) {
    console.error('Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN in Gazelle-back/.env');
    process.exit(1);
  }

  const byPhone = new Map();
  let ordersScanned = 0;
  let size37Orders = 0;

  console.log(`Fetching Shopify orders (target: ${TARGET} unique size-37 customers)…`);

  let nextUrl = '/orders.json?status=any&limit=250';
  while (nextUrl && byPhone.size < TARGET) {
    const { data, nextUrl: next } = await shopifyGet(nextUrl);
    const page = data.orders || [];

    for (const order of page) {
      ordersScanned += 1;
      const has37 = (order.line_items || []).some(lineIsSize37);
      if (!has37) continue;

      size37Orders += 1;
      const { name, phone } = extractContact(order);
      if (!name && !phone) continue;

      const key = phone || `no-phone:${name.toLowerCase()}`;
      if (byPhone.has(key)) continue;

      byPhone.set(key, {
        name: name || '—',
        phone: phone || '—',
        lastOrder: order.name || order.order_number,
        lastOrderDate: order.created_at || '',
        city: order.shipping_address?.city || order.billing_address?.city || '',
      });

      if (byPhone.size >= TARGET) break;
    }

    if (ordersScanned % 2500 === 0 || byPhone.size >= TARGET) {
      console.log(`  …${ordersScanned} orders scanned, ${byPhone.size} unique contacts`);
    }
    nextUrl = byPhone.size >= TARGET ? null : next;
  }

  const rows = [...byPhone.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), 'ar')
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Size 37 customers');
  sheet.columns = [
    { header: 'Name', key: 'name', width: 32 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'City', key: 'city', width: 20 },
    { header: 'Last order #', key: 'lastOrder', width: 14 },
    { header: 'Last order date', key: 'lastOrderDate', width: 22 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);

  const buffer = await workbook.xlsx.writeBuffer();
  await writeFile(OUT_PATH, buffer);

  console.log('\nDone.');
  console.log(`  Orders scanned:     ${ordersScanned}`);
  console.log(`  Orders with size 37:  ${size37Orders}`);
  console.log(`  Unique contacts:    ${rows.length}`);
  console.log(`  Saved to:           ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
