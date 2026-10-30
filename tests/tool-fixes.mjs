// Offline checks for the tool fixes (schemas, handlers, tool groups). No real FUB request.
import assert from 'assert';
import axios from 'axios';
process.env.FUB_API_KEY = 'offline-test';
process.env.FUB_SAFE_MODE = 'false';
process.env.FUB_SYSTEM = 'TEST';
process.env.FUB_SYSTEM_KEY = 'TEST';
const calls = [];
axios.create = () => new Proxy({ interceptors: { request: { use() {} }, response: { use() {} } } }, {
  get: (t, method) => method in t ? t[method] : async (...args) => { calls.push({ method, args }); return { data: {} }; }
});
const m = await import('../index.js');
const last = () => calls[calls.length - 1];
async function run(name, args) { await m.handleToolCall(name, args); return last(); }

let c = await run('listPeople', { stage: 'Lead' });
assert.strictEqual(c.args[1].params.sort, '-created', 'listPeople defaults newest first');
c = await run('listPeople', { sort: 'name' });
assert.strictEqual(c.args[1].params.sort, 'name', 'caller sort wins');
c = await run('createTask', { personId: 1, name: 'x', isCompleted: true, assignedUserId: 1, dueDate: '2026-10-30' });
assert.strictEqual(c.args[1].isCompleted, true); assert.ok(!('status' in c.args[1]));
c = await run('createTextMessageTemplate', { name: 'n', message: 'hi' });
assert.strictEqual(c.args[1].message, 'hi');
c = await run('createReaction', { refType: 'Note', refId: 5, body: '👍' });
assert.strictEqual(c.args[0], '/reactions/Note/5'); assert.strictEqual(c.args[1].body, '👍');
c = await run('createReaction', { refType: 'Note', refId: 5, emoji: '👍' });
assert.strictEqual(c.args[1].body, '👍', 'legacy emoji maps to body');
c = await run('inboxAppAddMessage', { inboxAppId: 7, externalConversationId: 'c1', externalMessageId: 'm1', message: 'x', isIncoming: true, sender: {} });
assert.strictEqual(c.args[0], '/inboxApps/7/message'); assert.ok(!('inboxAppId' in c.args[1]));
c = await run('inboxAppDeleteParticipant', { inboxAppId: 7, extConversationId: 'a b', participantId: 9 });
assert.strictEqual(c.args[0], '/inboxApps/7/conversations/a%20b/participants/9');
c = await run('createAppointment', { title: 't', start: '2026-10-30T10:00:00Z', end: '2026-10-30T11:00:00Z', sendInvitation: false });
assert.deepStrictEqual(c.args[2], { params: { sendInvitation: false } }); assert.ok(!('sendInvitation' in c.args[1]));
c = await run('createGroup', { name: 'g', userIds: [1] });
assert.deepStrictEqual(c.args[1].users, [1]);

// Tool list: no duplicates, annotations on all, alwaysLoad on hot tools, extras replace built-ins.
const extra = [{ name: 'mergeTemplate', description: 'custom', inputSchema: { type: 'object', properties: {} } },
               { name: 'sendNotification', description: 'custom', inputSchema: { type: 'object', properties: {} } }];
const names = m.activeTools.map(t => t.name);
assert.strictEqual(new Set(names).size, names.length, 'no duplicate engine names');
for (const t of m.activeTools) assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', t.name);
assert.strictEqual(m.activeTools.find(t => t.name === 'listPeople')._meta['anthropic/alwaysLoad'], true);
assert.strictEqual(m.toolAnnotations('deletePerson').destructiveHint, true);
assert.strictEqual(m.toolAnnotations('listPeople').readOnlyHint, true);
assert.strictEqual(m.toolAnnotations('sendNotification').openWorldHint, true);
assert.ok(m.DEFAULT_INSTRUCTIONS.includes('listPeople stage="Lead"'));
for (const t of m.activeTools) for (const r of (t.inputSchema.required || [])) assert.ok(r in t.inputSchema.properties, `${t.name} required ${r}`);
console.log(`tool-fixes: all checks passed (${m.activeTools.length} tools)`);
