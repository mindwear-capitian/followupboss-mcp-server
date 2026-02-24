#!/usr/bin/env node

/**
 * Quick test -- verifies the MCP server starts, responds to protocol
 * handshake, and can make a read-only API call to Follow Up Boss.
 *
 * Usage: npm test
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, 'index.js');

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  PASS  ${label}`);
}

function fail(label, err) {
  failed++;
  console.error(`  FAIL  ${label}: ${err}`);
}

async function run() {
  console.log('\nFollow Up Boss MCP Server -- Quick Test\n');

  // 1. Start server and connect
  let client;
  try {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: { ...process.env },
    });
    client = new Client({ name: 'fub-test', version: '1.0.0' });
    await client.connect(transport);
    ok('Server starts and MCP handshake succeeds');
  } catch (err) {
    fail('Server starts and MCP handshake succeeds', err.message);
    console.error('\nCannot continue without a connection. Check your .env or FUB_API_KEY.\n');
    process.exit(1);
  }

  // 2. List tools
  let tools;
  try {
    const result = await client.listTools();
    tools = result.tools;
    if (tools.length >= 130) {
      ok(`Lists ${tools.length} tools`);
    } else {
      fail(`Lists tools`, `Expected 130+, got ${tools.length}`);
    }
  } catch (err) {
    fail('Lists tools', err.message);
  }

  // 3. Read-only API call -- get account identity
  try {
    const result = await client.callTool({ name: 'getIdentity', arguments: {} });
    const content = result.content?.[0]?.text;
    if (content) {
      const data = JSON.parse(content);
      // FUB identity can return nested or flat -- just verify we got real data back
      const flat = data.userId || data.id || data.email || data.accountId;
      const nested = data.identity?.userId || data.identity?.email;
      const label = data.email || data.identity?.email || data.name || data.identity?.name || 'ok';
      if (flat || nested || Object.keys(data).length > 0) {
        ok(`Read-only API call works (account: ${label})`);
      } else {
        fail('Read-only API call', 'Empty response');
      }
    } else {
      fail('Read-only API call', 'No content returned');
    }
  } catch (err) {
    fail('Read-only API call', err.message);
  }

  // Done
  console.log(`\n${passed} passed, ${failed} failed\n`);
  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
