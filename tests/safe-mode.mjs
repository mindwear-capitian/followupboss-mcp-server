#!/usr/bin/env node
/**
 * Safe Mode enforcement + default regression tests.
 *
 * Covers the two issues fixed in v1.4.0:
 *   1. Safe Mode must default ON when FUB_SAFE_MODE is unset (was OFF pre-1.4.0,
 *      contradicting SECURITY.md / README which both promised safe-by-default).
 *   2. handleToolCall must enforce Safe Mode itself, so overlays/forks that import
 *      it directly cannot dispatch delete tools (the guard used to live ONLY in
 *      createServer's request handler, leaving handleToolCall unguarded).
 *
 * Run: node tests/safe-mode.mjs   (no real API key or network needed)
 */
import assert from 'assert';

// A non-placeholder dummy key so the module loads; the guard is checked before
// any network call, so no real FUB request is ever made by this test.
process.env.FUB_API_KEY = 'fka_test';
// Intentionally leave FUB_SAFE_MODE unset — that is the case under test.
delete process.env.FUB_SAFE_MODE;

const m = await import('../index.js');

// 1. Default is SAFE when unset.
assert.strictEqual(m.FUB_SAFE_MODE, true,
  'FUB_SAFE_MODE must default to true (SAFE) when the env var is unset');

// 2. isDeleteTool classifies correctly.
for (const n of ['deletePerson', 'deleteDeal', 'inboxAppDeleteParticipant', 'deleteReaction'])
  assert.ok(m.isDeleteTool(n), `isDeleteTool('${n}') should be true`);
for (const n of ['getPerson', 'createPerson', 'updateDeal', 'listPeople'])
  assert.ok(!m.isDeleteTool(n), `isDeleteTool('${n}') should be false`);

// 3. Bug 2 regression: direct handleToolCall import must block deletes in Safe Mode.
await assert.rejects(
  () => m.handleToolCall('deletePerson', { id: 1 }),
  /disabled in Safe Mode/,
  'handleToolCall must block delete tools in Safe Mode (pre-1.4.0 bypass regression)'
);

// 4. Advertised tool surface must not include delete tools in Safe Mode.
assert.ok(!m.activeTools.some(t => m.isDeleteTool(t.name)),
  'activeTools must not advertise delete tools when Safe Mode is on');

console.log(`safe-mode: all checks passed (${m.activeTools.length} tools advertised, deletes hidden)`);
