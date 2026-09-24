#!/usr/bin/env node
/**
 * Verify that explicitly selected Full Access advertises and dispatches
 * DELETE-backed tools. No real API key or network access is used.
 */
import assert from 'assert';
import axios from 'axios';

process.env.FUB_API_KEY = 'fka_test';
process.env.FUB_SAFE_MODE = 'false';

const requests = [];
axios.create = () => new Proxy({}, {
  get: (_target, method) => async (...args) => {
    requests.push({ method, args });
    return { data: {} };
  }
});

const m = await import('../index.js');

assert.strictEqual(m.FUB_SAFE_MODE, false,
  'FUB_SAFE_MODE=false must explicitly enable Full Access');
assert.ok(m.activeTools.some(t => t.name === 'inboxAppDeactivate'),
  'Full Access must advertise inboxAppDeactivate');

const result = await m.handleToolCall('inboxAppDeactivate', { id: 42 });
assert.deepStrictEqual(result, {
  success: true,
  message: 'Inbox app 42 deactivated'
});
assert.deepStrictEqual(requests, [
  { method: 'delete', args: ['/inboxApps/42'] }
], 'Full Access must dispatch the intended DELETE request');

console.log('full-access: inboxAppDeactivate advertised and dispatched with mocked HTTP');
