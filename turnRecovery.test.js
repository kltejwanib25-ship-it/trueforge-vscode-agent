const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runTurnWithRecovery, retryDelay } = require('./turnRecovery');

function setup(states) {
  const requests = [];
  const waits = [];
  const client = { sessions: {
    async createTurnStream(id, request) {
      requests.push({ id, request });
      const state = states.shift();
      if (state instanceof Error) throw state;
      return { async *withMetadata() {
        if (state) yield { data: { type: 'turn.done', state } };
      } };
    },
    async cancel() {}
  } };
  const run = { controller: new AbortController() };
  return { requests, waits, run, options: {
    client, sessionId: 'same-session', message: 'edit', run,
    onEvent() {}, wait: async milliseconds => { waits.push(milliseconds); }
  } };
}

test('successful turn makes one request', async () => {
  const f = setup([{ status: 'done' }]);
  assert.equal((await runTurnWithRecovery(f.options)).status, 'done');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.waits, []);
});
test('429 and 503 recover in the same session with bounded delays', async () => {
  const f = setup([{status:'error',message:'429 too many requests'}, {status:'error',message:'503 high demand'}, {status:'done'}]);
  assert.equal((await runTurnWithRecovery(f.options)).status, 'done');
  assert.deepEqual(f.waits, [60000,120000]);
  assert.ok(f.requests.every(r => r.id === 'same-session'));
  assert.equal(f.requests[1].request.previousTurnId, 'auto');
  assert.match(f.requests[1].request.input[0].content, /respect rejected edits/);
});
test('retry limit stops a repeatedly failed run', async () => {
  const f = setup(Array.from({length:3}, () => ({status:'error',message:'503'})));
  assert.equal((await runTurnWithRecovery(f.options)).status, 'error');
  assert.equal(f.requests.length, 3);
});
test('billing, daily and zero quota failures stop immediately', async () => {
  for (const message of ['429 requestsPerDay quota', '429 billing required', '429 limit: 0']) {
    const f = setup([{status:'error',message}]);
    assert.equal((await runTurnWithRecovery(f.options)).status, 'error');
    assert.equal(f.requests.length, 1);
  }
});
test('server cancellation never retries', async () => {
  const f = setup([{status:'cancelled'}]);
  assert.equal((await runTurnWithRecovery(f.options)).status, 'cancelled');
  assert.equal(f.requests.length, 1);
});
test('cancel during backoff prevents another request', async () => {
  const f = setup([{status:'error',message:'429'}]);
  f.options.wait = async () => { f.run.controller.abort(); throw new Error('aborted'); };
  assert.equal((await runTurnWithRecovery(f.options)).status, 'cancelled');
  assert.equal(f.requests.length, 1);
});
test('transport failures are not replayed', async () => {
  const f = setup([new Error('socket closed')]);
  await assert.rejects(runTurnWithRecovery(f.options), /Check its state/);
  assert.equal(f.requests.length, 1);
});
test('missing final state is reported without replay', async () => {
  const f = setup([null]);
  await assert.rejects(runTurnWithRecovery(f.options), /without a final state/);
  assert.equal(f.requests.length, 1);
});
test('provider retry hints are honored within the bound', () => {
  assert.equal(retryDelay('429 retry in 90s', 0), 90000);
  assert.equal(retryDelay('429 retry after 600s', 0), null);
  assert.equal(retryDelay('invalid api key', 0), null);
  assert.equal(retryDelay('Headers Timeout Error', 0), 60000);
});
test('cancel before request sends nothing', async () => {
  const f = setup([]);
  f.run.controller.abort();
  assert.equal((await runTurnWithRecovery(f.options)).status, 'cancelled');
  assert.equal(f.requests.length, 0);
});
