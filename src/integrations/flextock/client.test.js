import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFlextockConfiguredSync,
  cleanFlextockSecret,
  flextockCredentials,
} from './client.js';
import { config } from '../../config/index.js';

test('Flextock stays off until username, password, and key are all set (env/cache)', () => {
  const ready = Boolean(config.FLEXTOCK_USERNAME && config.FLEXTOCK_PASSWORD && config.FLEXTOCK_API_KEY);
  assert.equal(isFlextockConfiguredSync(), ready);
  const creds = flextockCredentials();
  assert.equal(Boolean(creds.username && creds.password && creds.key), ready);
});

test('cleans Render-pasted secrets with quotes/spaces', () => {
  assert.equal(cleanFlextockSecret('  "abc"  '), 'abc');
  assert.equal(cleanFlextockSecret("'xyz'"), 'xyz');
});
