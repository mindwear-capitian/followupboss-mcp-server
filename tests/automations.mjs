// Offline check: listAutomations returns rows whatever collection key FUB uses. No real FUB request.
import assert from 'assert';
import axios from 'axios';
process.env.FUB_API_KEY = 'offline-test';
process.env.FUB_SYSTEM = 'TEST';
process.env.FUB_SYSTEM_KEY = 'TEST';
let body = {};
axios.create = () => new Proxy({ interceptors: { request: { use() {} }, response: { use() {} } } }, {
  get: (t, method) => method in t ? t[method] : async () => ({ data: body })
});
const m = await import('../index.js');
const meta = { collection: 'automationsnew', total: 2 };

body = { _metadata: meta, automationsnew: [{ id: 1 }, { id: 2 }] };
let r = await m.handleToolCall('listAutomations', {});
assert.deepStrictEqual(r.automations, [{ id: 1 }, { id: 2 }], 'reads FUB automationsnew key');
assert.deepStrictEqual(r._metadata, meta);

body = { _metadata: meta, automations: [{ id: 3 }] };
r = await m.handleToolCall('listAutomations', {});
assert.deepStrictEqual(r.automations, [{ id: 3 }], 'still reads legacy automations key');
// People lists already match FUB's keys; guard them against regression.
body = { _metadata: {}, automationsPeople: [{ id: 4 }] };
r = await m.handleToolCall('listAutomationsPeople', {});
assert.deepStrictEqual(r.automationsPeople, [{ id: 4 }], 'listAutomationsPeople rows');
body = { _metadata: {}, actionPlansPeople: [{ id: 5 }] };
r = await m.handleToolCall('listActionPlansPeople', {});
assert.deepStrictEqual(r.actionPlansPeople, [{ id: 5 }], 'listActionPlansPeople rows');
console.log('automations: all checks passed');
