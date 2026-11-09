import test from 'node:test';
import assert from 'node:assert/strict';
import { isFlextockConfigured } from './client.js';
import { config } from '../../config/index.js';

test('Flextock stays off until username, password, and key are all set', () => {
  const ready = Boolean(config.FLEXTOCK_USERNAME && config.FLEXTOCK_PASSWORD && config.FLEXTOCK_API_KEY);
  assert.equal(isFlextockConfigured(), ready);
});
