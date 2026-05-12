#!/usr/bin/env node
/**
 * Targeted regression test for the May-11 audit fixes.
 * Boots the server and exercises:
 *   1. wait_for_previous strip (no 400)
 *   2. createCall schema (legacy direction/notes → isIncoming/note)
 *   3. createDeal schema (legacy personId/value → peopleIds/price)
 *   4. createDealCustomField (name → label)
 *   5. createAppointment (startTime/endTime/personId → start/end/invitees)
 *   6. listInboxAppInstallations path (/inboxApps not /inboxApps/installations)
 *
 * Read-only where possible; write tests dry-run via SAFE MODE-friendly probes.
 * Anything that returns 400 with "Invalid fields" is a regression.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, 'index.js');

function loadDotEnv() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(__dirname, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > -1) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch {}
  return out;
}
const DOTENV = loadDotEnv();

let pass = 0, fail = 0;
const PASS = (l) => { pass++; console.log(`  PASS  ${l}`); };
const FAIL = (l, err) => { fail++; console.error(`  FAIL  ${l}: ${err}`); };

function parse(result) {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : {};
}

function unexpectedFieldsError(data) {
  // FUB 400 returns errorMessage like "Invalid fields in the request body: foo".
  const msg = data?.error || data?.details?.errorMessage || '';
  return /Invalid fields in the request body/i.test(msg);
}

async function run() {
  console.log('\nFUB MCP Server — Audit-Fix Regression Test\n');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...process.env, ...DOTENV, FUB_SAFE_MODE: 'true' },
  });
  const client = new Client({ name: 'fub-fix-test', version: '1.0.0' });
  await client.connect(transport);

  // 1. wait_for_previous must not be forwarded
  try {
    const r = await client.callTool({
      name: 'getIdentity',
      arguments: { wait_for_previous: true },
    });
    const data = parse(r);
    if (unexpectedFieldsError(data)) {
      FAIL('strip wait_for_previous from args', `still forwarded → ${data.error}`);
    } else {
      PASS('strip wait_for_previous from args (no 400)');
    }
  } catch (e) { FAIL('strip wait_for_previous from args', e.message); }

  // 2. createCall: legacy direction/notes translated → isIncoming/note.
  // Use a clearly bogus personId so FUB returns "not found" rather than success.
  // What we're verifying: NOT a 400 "Invalid fields ... direction|notes" error.
  try {
    const r = await client.callTool({
      name: 'createCall',
      arguments: { personId: 999999999, direction: 'outbound', notes: 'test', duration: 1 },
    });
    const data = parse(r);
    if (/Invalid fields/i.test(data.error || '') && /direction|notes/i.test(data.error)) {
      FAIL('createCall legacy direction/notes translated', `still forwarded → ${data.error}`);
    } else {
      PASS('createCall legacy direction/notes translated (no field rejection)');
    }
  } catch (e) { FAIL('createCall translator', e.message); }

  // 3. createDeal: legacy personId/value translated → peopleIds/price.
  try {
    const r = await client.callTool({
      name: 'createDeal',
      arguments: { name: 'TEST_FIXTURE_DO_NOT_USE', stageId: 999999999, personId: 999999999, value: 100 },
    });
    const data = parse(r);
    if (/Invalid fields/i.test(data.error || '') && /personId|value/i.test(data.error)) {
      FAIL('createDeal legacy personId/value translated', `still forwarded → ${data.error}`);
    } else {
      PASS('createDeal legacy personId/value translated (no field rejection)');
    }
  } catch (e) { FAIL('createDeal translator', e.message); }

  // 4. createDealCustomField: legacy name → label.
  try {
    const r = await client.callTool({
      name: 'createDealCustomField',
      arguments: { name: '__test_zzz_audit_fix', type: 'text' },
    });
    const data = parse(r);
    if (/label cannot be blank/i.test(data.error || '')) {
      FAIL('createDealCustomField name→label', `label still missing → ${data.error}`);
    } else if (/Invalid fields/i.test(data.error || '') && /\bname\b/.test(data.error)) {
      FAIL('createDealCustomField name→label', `name still forwarded → ${data.error}`);
    } else {
      PASS('createDealCustomField name→label translated');
    }
  } catch (e) { FAIL('createDealCustomField translator', e.message); }

  // 5. createAppointment: legacy startTime/endTime/personId/appointmentTypeId translation.
  try {
    const r = await client.callTool({
      name: 'createAppointment',
      arguments: {
        title: '__test_audit_fix',
        startTime: '2030-01-01T10:00:00Z',
        endTime: '2030-01-01T11:00:00Z',
        personId: 999999999,
        appointmentTypeId: 999999999,
      },
    });
    const data = parse(r);
    if (/Invalid fields/i.test(data.error || '') &&
        /(startTime|endTime|personId|appointmentTypeId)/.test(data.error)) {
      FAIL('createAppointment legacy fields translated', `still forwarded → ${data.error}`);
    } else {
      PASS('createAppointment legacy fields translated');
    }
  } catch (e) { FAIL('createAppointment translator', e.message); }

  // 6. listInboxAppInstallations: must now hit /inboxApps, NOT 404 on empty collection.
  try {
    const r = await client.callTool({ name: 'listInboxAppInstallations', arguments: {} });
    const data = parse(r);
    if (/Collection name '' in the URL is not valid/i.test(data.error || '')) {
      FAIL('listInboxAppInstallations path fix', `still hitting bad path → ${data.error}`);
    } else {
      PASS('listInboxAppInstallations path fix (no empty-collection 404)');
    }
  } catch (e) { FAIL('listInboxAppInstallations', e.message); }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await client.close();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
