import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinAwakeWindow, parseAwakeHours, parseOffDays } from './keepAwake.js';

const workdays = { start: 8, end: 24, offDays: ['fri'] };

test('parses hours and off days with safe fallbacks', () => {
  assert.deepEqual(parseAwakeHours('9-2'), { start: 9, end: 2 });
  assert.deepEqual(parseAwakeHours('nonsense'), { start: 8, end: 24 });
  assert.deepEqual(parseOffDays('Friday, sat, xyz'), ['fri', 'sat']);
});

test('stays awake during Sat-Thu working hours (Cairo)', () => {
  // 2026-10-04 is a Sunday; Cairo is UTC+3 in October.
  assert.equal(isWithinAwakeWindow(new Date('2026-10-04T07:00:00Z'), workdays), true); // 10:00
  assert.equal(isWithinAwakeWindow(new Date('2026-10-04T20:59:00Z'), workdays), true); // 23:59
  assert.equal(isWithinAwakeWindow(new Date('2026-10-03T06:30:00Z'), workdays), true); // Sat 09:30
});

test('sleeps at night and all day Friday', () => {
  assert.equal(isWithinAwakeWindow(new Date('2026-10-04T02:00:00Z'), workdays), false); // 05:00
  assert.equal(isWithinAwakeWindow(new Date('2026-10-04T21:30:00Z'), workdays), false); // 00:30 Mon
  assert.equal(isWithinAwakeWindow(new Date('2026-10-02T09:00:00Z'), workdays), false); // Fri 12:00
});

test('past-midnight shifts belong to the day they started', () => {
  const late = { start: 9, end: 2, offDays: ['fri'] };
  assert.equal(isWithinAwakeWindow(new Date('2026-10-01T22:30:00Z'), late), true); // Fri 01:30, Thu shift
  assert.equal(isWithinAwakeWindow(new Date('2026-10-02T22:30:00Z'), late), false); // Sat 01:30, Fri shift
  assert.equal(isWithinAwakeWindow(new Date('2026-10-02T00:00:00Z'), late), false); // Fri 03:00
});
