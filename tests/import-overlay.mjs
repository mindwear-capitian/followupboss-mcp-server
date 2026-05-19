#!/usr/bin/env node
/**
 * Verify public can be imported and extended with an overlay.
 * This is the contract that projects extending the server rely on.
 */
import { createServer, startStdio, startHttp, activeTools, TOOL_DEFINITIONS, FUB_SAFE_MODE, handleToolCall } from '../index.js';

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log(`  PASS  ${l}`); };
const bad = (l, e) => { fail++; console.log(`  FAIL  ${l} -- ${e}`); };

// 1. All exports are defined
if (typeof createServer === 'function') ok('createServer is exported function');
else bad('createServer', typeof createServer);

if (typeof startStdio === 'function') ok('startStdio is exported function');
else bad('startStdio', typeof startStdio);

if (typeof startHttp === 'function') ok('startHttp is exported function');
else bad('startHttp', typeof startHttp);

if (typeof handleToolCall === 'function') ok('handleToolCall is exported function');
else bad('handleToolCall', typeof handleToolCall);

if (Array.isArray(activeTools) && activeTools.length > 100) ok(`activeTools is array (${activeTools.length} tools)`);
else bad('activeTools', typeof activeTools);

if (Array.isArray(TOOL_DEFINITIONS) && TOOL_DEFINITIONS.length >= 160) ok(`TOOL_DEFINITIONS has ${TOOL_DEFINITIONS.length} tools`);
else bad('TOOL_DEFINITIONS', TOOL_DEFINITIONS?.length);

if (typeof FUB_SAFE_MODE === 'boolean') ok(`FUB_SAFE_MODE is boolean (${FUB_SAFE_MODE})`);
else bad('FUB_SAFE_MODE', typeof FUB_SAFE_MODE);

// 2. createServer() with no opts works
const s1 = createServer();
if (s1 && typeof s1.connect === 'function') ok('createServer() returns Server instance');
else bad('createServer no-opts', s1);

// 3. createServer({ extraTools, extraHandler }) accepts overlay
const fakeOverlay = {
  extraTools: [
    { name: 'overlayDemo', description: 'test', inputSchema: { type: 'object', properties: {} } }
  ],
  extraHandler: async (name, args) => ({ called: name, args }),
  serverInfo: { name: 'custom-overlay', version: '0.1.0' }
};
const s2 = createServer(fakeOverlay);
if (s2 && typeof s2.connect === 'function') ok('createServer({extraTools,extraHandler}) returns Server');
else bad('createServer with overlay', s2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
