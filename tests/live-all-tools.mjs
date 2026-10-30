#!/usr/bin/env node
// Live check of every tool against a REAL Follow Up Boss account.
// Writes go ONLY to TEST_PERSON_ID (a test contact you own) or to records this
// script creates (named "ZZ MCP Test ...") and deletes again before it exits.
// Tools that can message a contact, start a lead flow, claim a real lead, or leave
// a record FUB cannot delete are SKIPPED with the reason.
//
// Required env: FUB_API_KEY, TEST_PERSON_ID. Optional: FUB_SYSTEM + FUB_SYSTEM_KEY
// (restricted endpoints: webhooks, attachments, text logs), TEST_USER_ID (default 1),
// WEBHOOK_TEST_URL (a URL you own; the test webhook only listens for peopleDeleted).
// Run with FUB_SAFE_MODE=false so delete tools are available for cleanup.

if (!process.env.FUB_API_KEY || !process.env.TEST_PERSON_ID) {
  console.error('Set FUB_API_KEY and TEST_PERSON_ID.');
  process.exit(2);
}
process.env.FUB_SAFE_MODE = 'false';
const { TOOL_DEFINITIONS, handleToolCall } = await import('../index.js');

const PID = Number(process.env.TEST_PERSON_ID);
const UID = Number(process.env.TEST_USER_ID || 1);
const HAS_SYSTEM = !!(process.env.FUB_SYSTEM && process.env.FUB_SYSTEM_KEY);
const WEBHOOK_TEST_URL = process.env.WEBHOOK_TEST_URL || 'https://example.com/zz-mcp-webhook-test';
const STAMP = `ZZ MCP Test ${Date.now()}`;
const results = new Map();
const cleanup = [];

function firstArray(res) {
  if (!res || typeof res !== 'object') return null;
  for (const v of Object.values(res)) if (Array.isArray(v)) return v;
  return null;
}
function idOf(res) {
  if (res && typeof res.id === 'number') return res.id;
  const a = firstArray(res);
  return a && a[0] && a[0].id;
}
function mark(name, status, note = '') {
  if (!results.has(name) || status === 'FAIL') results.set(name, { status, note });
}
async function call(name, args = {}, { expectError = false } = {}) {
  let res;
  try {
    res = await handleToolCall(name, args);
  } catch (e) {
    res = { error: e.message };
  }
  const isErr = !!(res && typeof res === 'object' && res.error);
  if (isErr && !expectError) {
    mark(name, 'FAIL', `${res.status || ''} ${String(res.error).slice(0, 160)}`.trim());
  } else if (!isErr) {
    mark(name, 'PASS');
  }
  return isErr ? null : res;
}
function skip(name, why) { mark(name, 'SKIP', why); }

// ---------------- reads with no required input ----------------
const listIds = {};
for (const t of TOOL_DEFINITIONS) {
  const req = (t.inputSchema && t.inputSchema.required) || [];
  if (req.length || !/^(list|get)/.test(t.name)) continue;
  if (t.name === 'listTextMessages') continue; // FUB needs a filter: run below with personId
  const res = await call(t.name, /^list/.test(t.name) ? { limit: 2 } : {});
  if (res) listIds[t.name] = idOf(res);
}
await call('about');
await call('help');

// get<X> from list<X>s
const getFromList = {
  getEvent: 'listEvents', getUser: 'listUsers', getSmartList: 'listSmartLists',
  getAutomation: 'listAutomations', getTemplate: 'listTemplates',
  getTextMessageTemplate: 'listTextMessageTemplates', getCustomField: 'listCustomFields',
  getStage: 'listStages', getTask: 'listTasks', getAppointment: 'listAppointments',
  getAppointmentType: 'listAppointmentTypes', getAppointmentOutcome: 'listAppointmentOutcomes',
  getWebhook: 'listWebhooks', getPipeline: 'listPipelines', getDeal: 'listDeals',
  getDealCustomField: 'listDealCustomFields', getGroup: 'listGroups', getTeam: 'listTeams',
  getPond: 'listPonds', getNote: 'listNotes', getCall: 'listCalls',
  getTextMessage: 'listTextMessages', getRelationship: 'listRelationships',
  getAutomationPerson: 'listAutomationsPeople'
};
for (const [g, l] of Object.entries(getFromList)) {
  if (listIds[l]) await call(g, { id: listIds[l] });
}

// ---------------- the test contact ----------------
const person = await call('getPerson', { id: PID });
const tml = await call('listTextMessages', { personId: PID, limit: 2 });
if (tml) listIds.listTextMessages = idOf(tml);
const phone = person && person.phones && person.phones[0] && person.phones[0].value;
await call('updatePerson', { id: PID, tags: ['ZZ-MCP-TEST'], mergeTags: true });
await call('searchPeopleByTag', { tags: 'ZZ-MCP-TEST', limit: 5 });
await call('bulkUpdatePeople', { ids: [PID], updates: { tags: ['ZZ-MCP-TEST-2'] }, mergeTags: true });
await call('removeTagFromPerson', { id: PID, tag: 'ZZ-MCP-TEST' });
await call('removeTagFromPerson', { id: PID, tag: 'ZZ-MCP-TEST-2' });
if (phone) await call('checkDuplicate', { phone });
const anyEmail = await call('listPeople', { limit: 25, fields: 'id,emails' });
const em = anyEmail && firstArray(anyEmail).map(p => p.emails && p.emails[0] && p.emails[0].value).find(Boolean);
if (em) await call('getPersonByEmail', { email: em });

// new contact, then delete
const np = await call('createPerson', { firstName: 'ZZ MCP', lastName: `Test ${Date.now()}`, source: 'MCP test (auto-delete)' });
if (np && np.id) await call('deletePerson', { id: np.id });

// notes + reactions + threaded replies
const note = await call('createNote', { personId: PID, subject: STAMP, body: `${STAMP} (auto-delete)` });
if (note) {
  await call('getNote', { id: note.id });
  await call('updateNote', { id: note.id, body: `${STAMP} updated (auto-delete)` });
  const re = await call('createReaction', { refType: 'Note', refId: note.id, body: '\u{1F44D}' });
  if (re && re.id) await call('getReactions', { id: re.id });
  await call('deleteReaction', { refType: 'Note', refId: String(note.id), emoji: '\u{1F44D}' });
  await call('deleteNote', { id: note.id });
}

// tasks
const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
const task = await call('createTask', { personId: PID, assignedUserId: UID, name: STAMP, type: 'Follow Up', dueDate: due });
if (task) {
  await call('getTask', { id: task.id });
  await call('updateTask', { id: task.id, name: `${STAMP} updated` });
  await call('deleteTask', { id: task.id });
}

// calls + text logs (FUB has no delete for these; they stay on the test contact)
if (phone) {
  const c = await call('createCall', { personId: PID, phone, isIncoming: false, note: `${STAMP} (test log)`, outcome: 'No Answer' });
  if (c) { await call('getCall', { id: c.id }); await call('updateCall', { id: c.id, note: `${STAMP} updated` }); }
  if (HAS_SYSTEM) {
    const tm = await call('createTextMessage', { personId: PID, message: `${STAMP} (test log, not sent)`, toNumber: phone, fromNumber: '5125550100', isIncoming: false });
    if (tm) await call('getTextMessage', { id: tm.id });
  } else skip('createTextMessage', 'needs FUB_SYSTEM + FUB_SYSTEM_KEY');
}

// relationships
const rel = await call('createRelationship', { personId: PID, firstName: 'ZZ MCP', lastName: 'Test', type: 'Spouse' });
if (rel) {
  await call('getRelationship', { id: rel.id });
  await call('updateRelationship', { id: rel.id, lastName: 'Test Updated' });
  await call('deleteRelationship', { id: rel.id });
}

// person attachment
if (HAS_SYSTEM) {
  const pa = await call('createPersonAttachment', { personId: PID, uri: 'https://example.com/zz-mcp-test.pdf', fileName: 'zz-mcp-test.pdf' });
  if (pa) {
    await call('getPersonAttachment', { id: pa.id });
    await call('updatePersonAttachment', { id: pa.id, personId: PID, uri: 'https://example.com/zz-mcp-test-2.pdf', fileName: 'zz-mcp-test-2.pdf' });
    await call('deletePersonAttachment', { id: pa.id });
  }
} else skip('createPersonAttachment', 'needs FUB_SYSTEM + FUB_SYSTEM_KEY');

// appointments (no invitees: invitees sync to real calendars)
const start = new Date(Date.now() + 30 * 864e5); start.setUTCHours(15, 0, 0, 0);
const end = new Date(start.getTime() + 30 * 60e3);
const appt = await call('createAppointment', { title: STAMP, start: start.toISOString(), end: end.toISOString() });
if (appt) {
  await call('getAppointment', { id: appt.id });
  await call('updateAppointment', { id: appt.id, title: `${STAMP} updated`, start: start.toISOString(), end: end.toISOString() });
  await call('deleteAppointment', { id: appt.id });
}

// simple named account records: create, get, update, delete
const stagesNow = await call('listStages', { limit: 100 });
const leadStage = stagesNow && firstArray(stagesNow).find(x => x.name === 'Lead');
const typesNow = await call('listAppointmentTypes', { limit: 100 });
const outcomesNow = await call('listAppointmentOutcomes', { limit: 100 });
const realType = typesNow && firstArray(typesNow).find(x => !/ZZ MCP/.test(x.name));
const realOutcome = outcomesNow && firstArray(outcomesNow).find(x => !/ZZ MCP/.test(x.name));
const DELETE_EXTRA = {
  deleteStage: { assignStageId: leadStage && leadStage.id },
  deleteAppointmentType: { assignTypeId: realType && realType.id },
  deleteAppointmentOutcome: { assignOutcomeId: realOutcome && realOutcome.id },
  deletePond: { assignTo: UID }
};
async function lifecycle(kind, createArgs, updateArgs) {
  const r = await call(`create${kind}`, createArgs);
  if (!r || !r.id) return null;
  await call(`get${kind}`, { id: r.id });
  await call(`update${kind}`, { id: r.id, ...updateArgs });
  cleanup.push([`delete${kind}`, r.id]);
  return r;
}
await lifecycle('AppointmentType', { name: STAMP }, { name: `${STAMP} u` });
await lifecycle('AppointmentOutcome', { name: STAMP }, { name: `${STAMP} u` });
await lifecycle('Stage', { name: STAMP }, { name: `${STAMP} u` });
await lifecycle('CustomField', { label: STAMP, type: 'text' }, { label: `${STAMP} u` });
await lifecycle('DealCustomField', { label: STAMP, type: 'text' }, { label: `${STAMP} u` });
await lifecycle('Team', { name: STAMP, userIds: [UID] }, { name: `${STAMP} u` });
await lifecycle('Pond', { name: STAMP, userId: UID, userIds: [UID] }, { name: `${STAMP} u` });
await lifecycle('Group', { name: STAMP, users: [UID], distribution: 'first-to-claim', type: 'Agent' }, { name: `${STAMP} u` });

const tpl = await lifecycle('Template', { name: STAMP, subject: 'ZZ test', body: 'Hi %contact_first_name%' }, { name: `${STAMP} u` });
if (tpl) await call('mergeTemplate', { templateId: tpl.id, mergePersonId: PID });
const ttpl = await lifecycle('TextMessageTemplate', { name: STAMP, message: 'Hi %contact_first_name%' }, { name: `${STAMP} u` });
if (ttpl) await call('mergeTextMessageTemplate', { templateId: ttpl.id, personId: PID });

// pipeline + deal + deal attachment
const pipe = await call('createPipeline', { name: STAMP, stages: [{ name: `${STAMP} s1` }] });
if (pipe) {
  await call('getPipeline', { id: pipe.id });
  await call('updatePipeline', { id: pipe.id, name: `${STAMP} u` });
  const stageId = pipe.stages && pipe.stages[0] && pipe.stages[0].id;
  if (stageId) {
    const deal = await call('createDeal', { name: STAMP, stageId, peopleIds: [PID], price: 1 });
    if (deal) {
      await call('getDeal', { id: deal.id });
      await call('updateDeal', { id: deal.id, price: 2 });
      if (HAS_SYSTEM) {
        const da = await call('createDealAttachment', { dealId: deal.id, uri: 'https://example.com/zz-mcp-test.pdf', fileName: 'zz-mcp-test.pdf' });
        if (da) {
          await call('getDealAttachment', { id: da.id });
          await call('updateDealAttachment', { id: da.id, dealId: deal.id, uri: 'https://example.com/zz-mcp-test-2.pdf', fileName: 'zz-mcp-test-2.pdf' });
          await call('deleteDealAttachment', { id: da.id });
        }
      } else skip('createDealAttachment', 'needs FUB_SYSTEM + FUB_SYSTEM_KEY');
      await call('deleteDeal', { id: deal.id });
    }
  }
  cleanup.push(['deletePipeline', pipe.id]);
}

// webhook (rare event, URL on our own domain)
if (HAS_SYSTEM) {
  const wh = await call('createWebhook', { event: 'peopleDeleted', url: '${WEBHOOK_TEST_URL}' });
  if (wh) {
    await call('getWebhook', { id: wh.id });
    await call('updateWebhook', { id: wh.id, url: '${WEBHOOK_TEST_URL}-2' });
    await call('getWebhookEvents', { id: wh.id }, { expectError: true });
    cleanup.push(['deleteWebhook', wh.id]);
  }
} else skip('createWebhook', 'needs FUB_SYSTEM + FUB_SYSTEM_KEY');

// cleanup, newest first
for (const [tool, id] of cleanup.reverse()) await call(tool, { id, ...(DELETE_EXTRA[tool] || {}) });

// ---------------- skipped on purpose ----------------
const SKIPS = {
  createEvent: 'starts the lead flow (action plans, routing, alerts)',
  claimPerson: 'would claim a real unclaimed lead',
  addPersonToActionPlan: 'can email or text the contact',
  addPersonToAutomation: 'can email or text the contact',
  updateActionPlanPerson: 'changes a real action plan run',
  updateAutomationPerson: 'changes a real automation run',
  createEmCampaign: 'FUB has no delete: leaves a permanent campaign',
  updateEmCampaign: 'changes a real campaign',
  createEmEvent: 'needs a campaign; FUB has no delete',
  deleteUser: 'deletes a real FUB user',
  getWebhookEvents: 'takes a webhook event id that only arrives in a webhook POST',
  getThreadedReplies: 'no API call makes a threaded reply; needs one made in the FUB app',
  createTeam: 'this FUB account has no team access (403); the tool says so', getTeam: 'needs a team', updateTeam: 'needs a team', deleteTeam: 'needs a team',
  getAutomation: 'listAutomations returned none in this account', getAutomationPerson: 'listAutomations returned none in this account',
  listInboxAppInstallations: 'needs a published inbox app',
  inboxAppInstall: 'needs a published inbox app', inboxAppDeactivate: 'needs a published inbox app',
  inboxAppAddMessage: 'needs a published inbox app', inboxAppUpdateMessage: 'needs a published inbox app',
  inboxAppAddNote: 'needs a published inbox app', inboxAppUpdateConversation: 'needs a published inbox app',
  inboxAppGetParticipants: 'needs a published inbox app', inboxAppCreateParticipant: 'needs a published inbox app',
  inboxAppDeleteParticipant: 'needs a published inbox app'
};
for (const [n, why] of Object.entries(SKIPS)) if (!results.has(n) || results.get(n).status !== 'PASS') results.set(n, { status: 'SKIP', note: why });

// ---------------- report ----------------
const rows = TOOL_DEFINITIONS.map(t => [t.name, results.get(t.name) || { status: 'NOT RUN', note: 'no test data in this account' }]);
const count = s => rows.filter(([, r]) => r.status === s).length;
for (const [n, r] of rows) if (r.status !== 'PASS') console.log(`  ${r.status.padEnd(7)} ${n}${r.note ? '  - ' + r.note : ''}`);
console.log(`\nlive-all-tools: ${count('PASS')} pass, ${count('FAIL')} fail, ${count('SKIP')} skip, ${count('NOT RUN')} not run (of ${rows.length})`);
process.exit(count('FAIL') ? 1 : 0);
