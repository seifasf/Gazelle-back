import test from 'node:test';
import assert from 'node:assert/strict';
import { dateRangeFilter, rangeEnd, rangeStart, zonedDayBound } from './cairoTime.js';

test('bare day maps to Cairo midnight (summer, UTC+3)', () => {
  assert.equal(rangeStart('2026-07-15').toISOString(), '2026-07-14T21:00:00.000Z');
  assert.equal(rangeEnd('2026-07-15').toISOString(), '2026-07-15T20:59:59.999Z');
});

test('bare day maps to Cairo midnight (winter, UTC+2)', () => {
  assert.equal(rangeStart('2026-01-10').toISOString(), '2026-01-09T22:00:00.000Z');
  assert.equal(rangeEnd('2026-01-10').toISOString(), '2026-01-10T21:59:59.999Z');
});

test('full timestamps pass through unchanged', () => {
  assert.equal(rangeStart('2026-07-15T10:00:00.000Z').toISOString(), '2026-07-15T10:00:00.000Z');
  assert.equal(rangeEnd('2026-07-15T10:00:00.000Z').toISOString(), '2026-07-15T10:00:00.000Z');
});

test('invalid or empty values are ignored', () => {
  assert.equal(rangeStart(''), null);
  assert.equal(rangeEnd('not-a-date'), null);
  assert.equal(dateRangeFilter(undefined, ''), null);
  assert.equal(zonedDayBound('2026/07/15'), null);
});

test('dateRangeFilter builds only the bounds given', () => {
  assert.deepEqual(Object.keys(dateRangeFilter('2026-07-01', null)), ['$gte']);
  assert.deepEqual(Object.keys(dateRangeFilter(null, '2026-07-31')), ['$lte']);
  const both = dateRangeFilter('2026-07-01', '2026-07-31');
  assert.ok(both.$gte < both.$lte);
});
