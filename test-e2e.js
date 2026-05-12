#!/usr/bin/env node
/**
 * E2E test for the entire MCP server.
 *
 * Walks every safe tool against ONE tagged fake person, then deletes the
 * person and any test children at the end.
 *
 * Hard rules — do NOT touch:
 *   - createTextMessage         (would actually send an SMS to a real number)
 *   - createEvent               (could fire FUB action plans + emails)
 *   - addPersonToAutomation     (kicks off drip emails)
 *   - addPersonToActionPlan     (kicks off drip emails)
 *   - createWebhook             (registers a live webhook URL)
 *   - bulkUpdatePeople          (high blast radius on real data)
 *   - mergeTemplate, mergeTextMessageTemplate (could send)
 *   - claimPerson               (changes assignment on real people)
 *   - createEmEvent / createEmCampaign / update*  (touches real email tracking)
 *   - inbox app participant/message/note mutations (touches real conversations)
 *   - org-config writes: createPipeline/Stage/Group/Team/Pond/Template/CustomField/AppointmentType/AppointmentOutcome/TextMessageTemplate
 *
 * Needs FUB_SAFE_MODE=false so the harness can delete the fixture at the end.
 *
 * Usage:
 *   FUB_SAFE_MODE=false node test-e2e.js
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, 'index.js');

// Parent shells sometimes export FUB_API_KEY=YOUR_KEY_HERE (leftover from
// setup wizards). The server's .env loader honors process.env first, so a
// bogus parent value silently breaks auth. Load .env here and force-override.
function loadDotEnv() {
  const out = {};
  try {
    const c = readFileSync(resolve(__dirname, '.env'), 'utf8');
    for (const line of c.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch {}
  return out;
}
const DOTENV = loadDotEnv();

// Fixture identifiers — every test artifact gets tagged so you can hunt
// stragglers manually if cleanup fails.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const TEST_TAG = '__MCP_TEST_DELETE_ME';
const TEST_EMAIL = `mcp-test-${RUN_ID}@example.invalid`;
const TEST_FIRST = 'MCP_TEST';
const TEST_LAST = `DELETE_ME_${RUN_ID}`;

const results = []; // { category, tool, status: 'pass'|'fail'|'skip', note }
const state = {};   // id bag

function parse(result) {
  const text = result.content?.[0]?.text;
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}
// SDK Client.callTool does NOT always propagate result.isError as a top-level
// property — depends on transport / sdk version. The server-side payload IS
// reliable: an error response is shaped { error, status, details }.
function isErr(raw, data) {
  if (raw?.isError === true) return true;
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error.length > 0) return true;
    if (typeof data.status === 'number' && data.status >= 400) return true;
  }
  return false;
}
const errMsg = (data) => data?.error || data?.details?.errorMessage || JSON.stringify(data).slice(0, 200);

function PASS(category, tool, note = '') {
  results.push({ category, tool, status: 'pass', note });
  console.log(`  PASS  [${category}] ${tool}${note ? ' — ' + note : ''}`);
}
function FAIL(category, tool, note) {
  results.push({ category, tool, status: 'fail', note });
  console.error(`  FAIL  [${category}] ${tool} — ${note}`);
}
function SKIP(category, tool, note) {
  results.push({ category, tool, status: 'skip', note });
  console.log(`  SKIP  [${category}] ${tool} — ${note}`);
}

async function call(client, tool, args = {}) {
  const r = await client.callTool({ name: tool, arguments: args });
  const data = parse(r);
  return { raw: r, data, err: isErr(r, data) };
}

// Many list endpoints return either {x:[...]} or {x:[...], _metadata}.
// Also tolerate FUB returning a bare list under a different key.
function looksLikeList(d) {
  if (!d || typeof d !== 'object') return false;
  for (const v of Object.values(d)) if (Array.isArray(v)) return true;
  return false;
}

async function runReadOnlyList(client, category, tool, expectKey = null, opts = {}) {
  const { data, err } = await call(client, tool, opts.args || {});
  if (err) {
    const m = errMsg(data);
    if (data?.status === 403) return SKIP(category, tool, `403 (perms): ${m.slice(0, 100)}`);
    if (/X-System \+ X-System-Key headers/.test(m)) {
      return SKIP(category, tool, `needs registered system (FUB_SYSTEM creds)`);
    }
    if (data?.status === 404 && /inbox/i.test(tool)) {
      return SKIP(category, tool, `404 — needs registered system (FUB_SYSTEM)`);
    }
    if (data?.status === 404) return FAIL(category, tool, `404: ${m.slice(0, 100)}`);
    if (opts.tolerate400) return SKIP(category, tool, `400 (filter required): ${m.slice(0, 100)}`);
    return FAIL(category, tool, m.slice(0, 200));
  }
  if (expectKey && !(expectKey in data)) {
    if (looksLikeList(data) || Object.keys(data).length) return PASS(category, tool, `(returned ${Object.keys(data).join(',').slice(0,80)})`);
    return FAIL(category, tool, `missing key ${expectKey} in response`);
  }
  PASS(category, tool);
}

async function main() {
  console.log(`\nFUB MCP — E2E Test (run ${RUN_ID})\n`);
  console.log(`Fixture: ${TEST_FIRST} ${TEST_LAST} <${TEST_EMAIL}> tag=${TEST_TAG}\n`);

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    // Force-override with .env contents; a bogus parent FUB_API_KEY breaks auth.
    env: { ...process.env, ...DOTENV, FUB_SAFE_MODE: 'false' },
  });
  const client = new Client({ name: 'fub-e2e', version: '1.0.0' });
  await client.connect(transport);

  // -------------------------------------------------------------------------
  // 0. Meta
  // -------------------------------------------------------------------------
  for (const t of ['about', 'help']) {
    const { data, err } = await call(client, t);
    if (err) FAIL('meta', t, errMsg(data));
    else PASS('meta', t);
  }

  // -------------------------------------------------------------------------
  // 1. Identity
  // -------------------------------------------------------------------------
  for (const t of ['getIdentity', 'getCurrentUser']) {
    const { data, err } = await call(client, t);
    if (err) FAIL('identity', t, errMsg(data));
    else PASS('identity', t);
  }

  // -------------------------------------------------------------------------
  // 2. Discovery / read-only lists
  // -------------------------------------------------------------------------
  const readOnlyLists = [
    ['listPipelines',          'pipelines'],
    ['listStages',             'stages'],
    ['listUsers',              'users'],
    ['listGroups',             'groups'],
    ['listTeams',              'teams'],
    ['listPonds',              'ponds'],
    ['listTeamInboxes',        'teamInboxes'],
    ['listTimeframes',         'timeframes'],
    ['listSmartLists',         null],
    ['listTemplates',          null],
    ['listTextMessageTemplates', null],
    ['listActionPlans',        null],
    ['listActionPlansPeople',  null],
    ['listRoundRobinGroups',   null],
    ['listCustomFields',       null],
    ['listDealCustomFields',   null],
    ['listAppointmentTypes',   null],
    ['listAppointmentOutcomes', null],
    ['listAvailableTags',      null],
    ['listAutomations',        null],   // 403 expected
    ['listAutomationsPeople',  null],
    ['listEmCampaigns',        null],
    ['listInboxAppInstallations', null],
    ['listEvents',             'events'],
    ['listCalls',              'calls'],
    // listTextMessages requires a filter param; tested after person create.
    ['listTasks',              'tasks'],
    ['listAppointments',       'appointments'],
    ['listDeals',              'deals'],
    ['listWebhooks',           null],   // skipped below if no system creds
    ['listUnclaimed',          'people'],
    ['listRelationships',      'peopleRelationships'],
    ['listPeople',             'people'],
    ['listEmEvents',           null],
  ];

  // Skip webhooks if no creds — would error noisily.
  const wantWebhooks = !!(process.env.FUB_SYSTEM && process.env.FUB_SYSTEM_KEY);
  for (const [tool, key] of readOnlyLists) {
    if (tool === 'listWebhooks' && !wantWebhooks) {
      SKIP('lists', tool, 'no FUB_SYSTEM creds (expected — guarded path)');
      continue;
    }
    await runReadOnlyList(client, 'lists', tool, key);
  }

  // Need a real DEAL stage for createDeal. /stages returns PERSON stages
  // (pipelineId: null); deal stages live inside pipelines[].stages[].
  {
    const { data } = await call(client, 'listPipelines');
    const firstPipeline = (data.pipelines || [])[0];
    const firstStage = firstPipeline?.stages?.[0];
    if (firstStage?.id) {
      state.stageId = firstStage.id;
      state.pipelineId = firstPipeline.id;
    }
  }

  // -------------------------------------------------------------------------
  // 3. People lifecycle — CREATE FIXTURE PERSON
  // -------------------------------------------------------------------------
  {
    const args = {
      firstName: TEST_FIRST,
      lastName: TEST_LAST,
      emails: [{ type: 'work', value: TEST_EMAIL }],
      phones: [{ type: 'mobile', value: '+15555550100' }],   // fake reserved range
      tags: [TEST_TAG],
      source: 'mcp-e2e-test',
      stage: 'Lead',
    };
    const { data, err } = await call(client, 'createPerson', args);
    if (err) {
      FAIL('people', 'createPerson', errMsg(data));
      console.error('\nCannot continue without fixture person. Aborting.');
      await cleanup(client);
      await client.close();
      report(); process.exit(1);
    }
    state.personId = data.id || data.person?.id;
    PASS('people', 'createPerson', `id=${state.personId}`);
  }

  // Person read paths
  for (const t of [
    ['getPerson',         { id: state.personId }],
    ['getPersonByEmail',  { email: TEST_EMAIL }],
    ['searchPeopleByTag', { tag: TEST_TAG }],
    ['checkDuplicate',    { email: TEST_EMAIL }],   // FUB requires `email` (singular)
  ]) {
    const [tool, args] = t;
    const { data, err } = await call(client, tool, args);
    if (err) FAIL('people', tool, errMsg(data));
    else PASS('people', tool);
  }

  // listTextMessages requires a filter param; use personId.
  await runReadOnlyList(client, 'lists', 'listTextMessages', 'textMessages',
                        { args: { personId: state.personId } });

  // updatePerson
  {
    const { data, err } = await call(client, 'updatePerson', {
      id: state.personId,
      background: 'MCP E2E test fixture',
    });
    if (err) FAIL('people', 'updatePerson', errMsg(data));
    else PASS('people', 'updatePerson');
  }

  // -------------------------------------------------------------------------
  // 4. Notes
  // -------------------------------------------------------------------------
  {
    const { data, err } = await call(client, 'createNote', {
      personId: state.personId,
      subject: 'MCP test note',
      body: 'created by test-e2e.js',
    });
    if (err) FAIL('notes', 'createNote', errMsg(data));
    else { state.noteId = data.id; PASS('notes', 'createNote', `id=${state.noteId}`); }
  }
  if (state.noteId) {
    const { data, err } = await call(client, 'getNote', { id: state.noteId });
    err ? FAIL('notes', 'getNote', errMsg(data)) : PASS('notes', 'getNote');
  }
  if (state.noteId) {
    const { data, err } = await call(client, 'updateNote', { id: state.noteId, body: 'updated' });
    err ? FAIL('notes', 'updateNote', errMsg(data)) : PASS('notes', 'updateNote');
  }
  if (state.noteId) {
    const { data, err } = await call(client, 'deleteNote', { id: state.noteId });
    err ? FAIL('notes', 'deleteNote', errMsg(data)) : PASS('notes', 'deleteNote');
  }

  // -------------------------------------------------------------------------
  // 5. Calls — exercises createCall fix
  // -------------------------------------------------------------------------
  {
    const args = {
      personId: state.personId,
      phone: '+15555550100',
      isIncoming: false,
      duration: 30,
      note: 'mcp e2e call',
    };
    const { data, err } = await call(client, 'createCall', args);
    if (err) FAIL('calls', 'createCall (canonical)', errMsg(data));
    else { state.callId = data.id; PASS('calls', 'createCall (canonical)', `id=${state.callId}`); }
  }
  // Legacy-arg path exercises the translator
  {
    const args = {
      personId: state.personId,
      phone: '+15555550100',
      direction: 'inbound',
      notes: 'legacy-style call',
      duration: 10,
    };
    const { data, err } = await call(client, 'createCall', args);
    if (err) FAIL('calls', 'createCall (legacy translated)', errMsg(data));
    else { state.callIdLegacy = data.id; PASS('calls', 'createCall (legacy translated)', `id=${state.callIdLegacy}`); }
  }
  if (state.callId) {
    const { data, err } = await call(client, 'getCall', { id: state.callId });
    err ? FAIL('calls', 'getCall', errMsg(data)) : PASS('calls', 'getCall');
  }
  if (state.callId) {
    const { data, err } = await call(client, 'updateCall', { id: state.callId, note: 'updated note' });
    err ? FAIL('calls', 'updateCall', errMsg(data)) : PASS('calls', 'updateCall');
  }

  // -------------------------------------------------------------------------
  // 6. Tasks
  // -------------------------------------------------------------------------
  {
    const args = {
      personId: state.personId,
      name: 'MCP test task',
      dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    };
    const { data, err } = await call(client, 'createTask', args);
    if (err) FAIL('tasks', 'createTask', errMsg(data));
    else { state.taskId = data.id; PASS('tasks', 'createTask', `id=${state.taskId}`); }
  }
  if (state.taskId) {
    const { data, err } = await call(client, 'getTask', { id: state.taskId });
    err ? FAIL('tasks', 'getTask', errMsg(data)) : PASS('tasks', 'getTask');
  }
  if (state.taskId) {
    const { data, err } = await call(client, 'updateTask', { id: state.taskId, name: 'MCP test task (updated)' });
    err ? FAIL('tasks', 'updateTask', errMsg(data)) : PASS('tasks', 'updateTask');
  }
  if (state.taskId) {
    const { data, err } = await call(client, 'deleteTask', { id: state.taskId });
    err ? FAIL('tasks', 'deleteTask', errMsg(data)) : PASS('tasks', 'deleteTask');
  }

  // -------------------------------------------------------------------------
  // 7. Appointments — exercises createAppointment fix
  // -------------------------------------------------------------------------
  {
    const start = new Date(Date.now() + 7 * 86400000).toISOString();
    const end   = new Date(Date.now() + 7 * 86400000 + 3600000).toISOString();
    const args = {
      title: 'MCP test appointment',
      start,
      end,
      description: 'do not attend',
      invitees: [{ type: 'person', id: state.personId }],
    };
    const { data, err } = await call(client, 'createAppointment', args);
    if (err) FAIL('appointments', 'createAppointment (canonical)', errMsg(data));
    else { state.apptId = data.id; PASS('appointments', 'createAppointment (canonical)', `id=${state.apptId}`); }
  }
  // Legacy translator path
  {
    const args = {
      title: 'MCP test appt (legacy args)',
      startTime: new Date(Date.now() + 8 * 86400000).toISOString(),
      endTime:   new Date(Date.now() + 8 * 86400000 + 3600000).toISOString(),
      personId:  state.personId,
    };
    const { data, err } = await call(client, 'createAppointment', args);
    if (err) FAIL('appointments', 'createAppointment (legacy translated)', errMsg(data));
    else { state.apptIdLegacy = data.id; PASS('appointments', 'createAppointment (legacy translated)', `id=${state.apptIdLegacy}`); }
  }
  if (state.apptId) {
    const { data, err } = await call(client, 'getAppointment', { id: state.apptId });
    err ? FAIL('appointments', 'getAppointment', errMsg(data)) : PASS('appointments', 'getAppointment');
  }
  if (state.apptId) {
    // FUB requires start+end on every update — even title-only changes.
    const start = new Date(Date.now() + 7 * 86400000).toISOString();
    const end   = new Date(Date.now() + 7 * 86400000 + 3600000).toISOString();
    const { data, err } = await call(client, 'updateAppointment', {
      id: state.apptId, title: 'MCP test appt (updated)', start, end,
    });
    err ? FAIL('appointments', 'updateAppointment', errMsg(data)) : PASS('appointments', 'updateAppointment');
  }
  if (state.apptId) {
    const { data, err } = await call(client, 'deleteAppointment', { id: state.apptId });
    err ? FAIL('appointments', 'deleteAppointment', errMsg(data)) : PASS('appointments', 'deleteAppointment');
  }
  if (state.apptIdLegacy) {
    const { err } = await call(client, 'deleteAppointment', { id: state.apptIdLegacy });
    if (err) console.error(`  (cleanup) failed to delete legacy appt ${state.apptIdLegacy}`);
  }

  // -------------------------------------------------------------------------
  // 8. Deals + Deal Custom Fields
  // -------------------------------------------------------------------------
  if (!state.stageId) {
    SKIP('deals', 'createDeal', 'no stage found in listStages');
  } else {
    const args = {
      name: `MCP_TEST_DEAL_${RUN_ID}`,
      stageId: state.stageId,
      peopleIds: [state.personId],
      price: 1,
      description: 'mcp e2e fixture',
    };
    const { data, err } = await call(client, 'createDeal', args);
    if (err) FAIL('deals', 'createDeal (canonical)', errMsg(data));
    else { state.dealId = data.id; PASS('deals', 'createDeal (canonical)', `id=${state.dealId}`); }
  }
  // Legacy-arg deal
  if (state.stageId) {
    const args = {
      name: `MCP_TEST_DEAL_LEGACY_${RUN_ID}`,
      stageId: state.stageId,
      personId: state.personId,
      value: 1,
    };
    const { data, err } = await call(client, 'createDeal', args);
    if (err) FAIL('deals', 'createDeal (legacy translated)', errMsg(data));
    else { state.dealIdLegacy = data.id; PASS('deals', 'createDeal (legacy translated)', `id=${state.dealIdLegacy}`); }
  }
  if (state.dealId) {
    const { data, err } = await call(client, 'getDeal', { id: state.dealId });
    err ? FAIL('deals', 'getDeal', errMsg(data)) : PASS('deals', 'getDeal');
  }
  if (state.dealId) {
    const { data, err } = await call(client, 'updateDeal', { id: state.dealId, price: 2 });
    err ? FAIL('deals', 'updateDeal', errMsg(data)) : PASS('deals', 'updateDeal');
  }
  if (state.dealId) {
    const { data, err } = await call(client, 'deleteDeal', { id: state.dealId });
    err ? FAIL('deals', 'deleteDeal', errMsg(data)) : PASS('deals', 'deleteDeal');
  }
  if (state.dealIdLegacy) {
    const { err } = await call(client, 'deleteDeal', { id: state.dealIdLegacy });
    if (err) console.error(`  (cleanup) failed to delete legacy deal ${state.dealIdLegacy}`);
  }

  // Deal custom field round-trip
  {
    const args = { label: `__mcp_test_field_${RUN_ID}`, type: 'text' };
    const { data, err } = await call(client, 'createDealCustomField', args);
    if (err) FAIL('dealCustomFields', 'createDealCustomField (canonical)', errMsg(data));
    else { state.dcfId = data.id; PASS('dealCustomFields', 'createDealCustomField (canonical)', `id=${state.dcfId}`); }
  }
  if (state.dcfId) {
    const { data, err } = await call(client, 'getDealCustomField', { id: state.dcfId });
    err ? FAIL('dealCustomFields', 'getDealCustomField', errMsg(data)) : PASS('dealCustomFields', 'getDealCustomField');
  }
  if (state.dcfId) {
    const { data, err } = await call(client, 'updateDealCustomField', { id: state.dcfId, label: `__mcp_test_field_${RUN_ID}_v2` });
    err ? FAIL('dealCustomFields', 'updateDealCustomField', errMsg(data)) : PASS('dealCustomFields', 'updateDealCustomField');
  }
  if (state.dcfId) {
    const { data, err } = await call(client, 'deleteDealCustomField', { id: state.dcfId });
    err ? FAIL('dealCustomFields', 'deleteDealCustomField', errMsg(data)) : PASS('dealCustomFields', 'deleteDealCustomField');
  }

  // -------------------------------------------------------------------------
  // 9. Relationships — exercises createRelationship rewrite
  // -------------------------------------------------------------------------
  {
    const args = {
      personId: state.personId,
      firstName: 'MCP_REL',
      lastName: `TEST_${RUN_ID}`,
      type: 'Spouse',
    };
    const { data, err } = await call(client, 'createRelationship', args);
    if (err) FAIL('relationships', 'createRelationship', errMsg(data));
    else { state.relId = data.id; PASS('relationships', 'createRelationship', `id=${state.relId}`); }
  }
  if (state.relId) {
    const { data, err } = await call(client, 'getRelationship', { id: state.relId });
    err ? FAIL('relationships', 'getRelationship', errMsg(data)) : PASS('relationships', 'getRelationship');
  }
  if (state.relId) {
    const { data, err } = await call(client, 'updateRelationship', { id: state.relId, type: 'Partner' });
    err ? FAIL('relationships', 'updateRelationship', errMsg(data)) : PASS('relationships', 'updateRelationship');
  }
  if (state.relId) {
    const { data, err } = await call(client, 'deleteRelationship', { id: state.relId });
    err ? FAIL('relationships', 'deleteRelationship', errMsg(data)) : PASS('relationships', 'deleteRelationship');
  }

  // -------------------------------------------------------------------------
  // 10. Tags
  // -------------------------------------------------------------------------
  {
    const { data, err } = await call(client, 'removeTagFromPerson', { id: state.personId, tag: TEST_TAG });
    err ? FAIL('tags', 'removeTagFromPerson', errMsg(data)) : PASS('tags', 'removeTagFromPerson');
  }

  // -------------------------------------------------------------------------
  // 11. Tools we deliberately skip (sends, org-config, attachments)
  // -------------------------------------------------------------------------
  const skipTools = [
    ['createTextMessage',      'would send real SMS'],
    ['createEvent',            'could fire FUB action plans/emails'],
    ['createWebhook',          'registers live webhook'],
    ['bulkUpdatePeople',       'high blast radius on real data'],
    ['mergeTemplate',          'could trigger send'],
    ['mergeTextMessageTemplate', 'could trigger send'],
    ['claimPerson',            'reassigns real people'],
    ['createPipeline',         'org-config write'],
    ['createStage',            'org-config write'],
    ['createGroup',            'org-config write'],
    ['createTeam',             'org-config write'],
    ['createPond',             'org-config write'],
    ['createTemplate',         'org-config write'],
    ['createTextMessageTemplate', 'org-config write'],
    ['createCustomField',      'org-config write'],
    ['createAppointmentType',  'org-config write'],
    ['createAppointmentOutcome', 'org-config write'],
    ['createPersonAttachment', '403 in audit'],
    ['createDealAttachment',   '403 in audit'],
    ['inboxAppAddMessage',     'needs installed inbox app + real conversationId'],
    ['inboxAppAddNote',        'needs installed inbox app + real conversationId'],
    ['inboxAppCreateParticipant', 'needs installed inbox app + real conversationId'],
    ['inboxAppInstall',        'would install a real app'],
    ['inboxAppDeactivate',     'would deactivate an installation'],
    ['addPersonToAutomation',  'kicks off drip emails'],
    ['addPersonToActionPlan',  'kicks off drip emails'],
    ['createEmEvent',          'fake email tracking event'],
    ['createEmCampaign',       'could trigger sends'],
    ['createReaction',         'needs real ref item'],
  ];
  for (const [tool, why] of skipTools) SKIP('skipped', tool, why);

  // -------------------------------------------------------------------------
  // CLEANUP
  // -------------------------------------------------------------------------
  await cleanup(client);

  console.log(``);
  report();
  await client.close();
  process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
}

async function cleanup(client) {
  console.log(`\n--- CLEANUP ---`);
  if (state.dealId)        await tryDelete(client, 'deleteDeal',            { id: state.dealId });
  if (state.dealIdLegacy)  await tryDelete(client, 'deleteDeal',            { id: state.dealIdLegacy });
  if (state.dcfId)         await tryDelete(client, 'deleteDealCustomField', { id: state.dcfId });
  if (state.apptId)        await tryDelete(client, 'deleteAppointment',     { id: state.apptId });
  if (state.apptIdLegacy)  await tryDelete(client, 'deleteAppointment',     { id: state.apptIdLegacy });
  if (state.taskId)        await tryDelete(client, 'deleteTask',            { id: state.taskId });
  if (state.relId)         await tryDelete(client, 'deleteRelationship',    { id: state.relId });
  if (state.noteId)        await tryDelete(client, 'deleteNote',            { id: state.noteId });
  if (state.personId)      await tryDelete(client, 'deletePerson',          { id: state.personId });
}

async function tryDelete(client, tool, args) {
  try {
    const { data, err } = await call(client, tool, args);
    if (err) {
      // 404 means already gone — fine.
      if (data?.status === 404 || /not found/i.test(data?.error || '')) {
        console.log(`  (cleanup) ${tool} ${JSON.stringify(args)} — already gone`);
        return;
      }
      console.error(`  (cleanup) ${tool} ${JSON.stringify(args)} — ${errMsg(data).slice(0,160)}`);
      return;
    }
    console.log(`  (cleanup) ${tool} ${JSON.stringify(args)} — ok`);
  } catch (e) {
    console.error(`  (cleanup) ${tool} crashed: ${e.message}`);
  }
}

function report() {
  const byStatus = { pass: 0, fail: 0, skip: 0 };
  for (const r of results) byStatus[r.status]++;
  console.log(`\n=== SUMMARY ===`);
  console.log(`PASS: ${byStatus.pass}   FAIL: ${byStatus.fail}   SKIP: ${byStatus.skip}`);
  if (byStatus.fail) {
    console.log(`\nFailures:`);
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`  - [${r.category}] ${r.tool}: ${r.note}`);
    }
  }
}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });
