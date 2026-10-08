import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { withTransaction } from './transaction.js';

const realStartSession = mongoose.startSession;

function labelled(label, message = label) {
  const err = new Error(message);
  err.errorLabels = [label];
  return err;
}

function fakeSessions({ commitErrors = [] } = {}) {
  const stats = { started: 0, commits: 0, aborts: 0, ended: 0 };
  mongoose.startSession = async () => {
    stats.started += 1;
    let active = false;
    return {
      startTransaction: () => { active = true; },
      inTransaction: () => active,
      commitTransaction: async () => {
        stats.commits += 1;
        const err = commitErrors.shift();
        if (err) throw err;
        active = false;
      },
      abortTransaction: async () => { stats.aborts += 1; active = false; },
      endSession: () => { stats.ended += 1; },
    };
  };
  return stats;
}

afterEach(() => {
  mongoose.startSession = realStartSession;
});

test('retries the whole transaction on a write conflict', async () => {
  const stats = fakeSessions();
  let calls = 0;
  const result = await withTransaction(async () => {
    calls += 1;
    if (calls === 1) throw labelled('TransientTransactionError', 'WriteConflict');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(stats.started, 2);
  assert.equal(stats.ended, 2);
});

test('gives up after three transient failures', async () => {
  fakeSessions();
  let calls = 0;
  await assert.rejects(
    withTransaction(async () => {
      calls += 1;
      throw labelled('TransientTransactionError', 'WriteConflict');
    }),
    /WriteConflict/
  );
  assert.equal(calls, 3);
});

test('retries only the commit when its result is unknown', async () => {
  const stats = fakeSessions({ commitErrors: [labelled('UnknownTransactionCommitResult')] });
  let calls = 0;
  await withTransaction(async () => {
    calls += 1;
  });
  assert.equal(calls, 1);
  assert.equal(stats.commits, 2);
});

test('business errors are not retried', async () => {
  const stats = fakeSessions();
  let calls = 0;
  const err = new Error('Purchase order already received');
  err.statusCode = 409;
  await assert.rejects(
    withTransaction(async () => {
      calls += 1;
      throw err;
    }),
    /already received/
  );
  assert.equal(calls, 1);
  assert.equal(stats.aborts, 1);
});
