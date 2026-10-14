#!/usr/bin/env node
/**
 * Stateless HTTP transport, both protocol eras. Starts the server in a child
 * process with a static bearer token and calls only the local `about` tool,
 * so no FUB request is made.
 *
 *   node tests/http-eras.mjs
 */
import assert from 'assert';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'http-eras-test-token';
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

let pass = 0;
const ok = (label) => { pass++; console.log(`  PASS  ${label}`); };

async function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MCP_TRANSPORT: 'http',
      PORT: String(port),
      MCP_BEARER_TOKEN: TOKEN,
      MCP_LOG_ERA: 'false',
      FUB_API_KEY: 'fka_http_eras_dummy',
      ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50; i++) {
    if (log.includes('listening on')) return child;
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start:\n${log}`);
}

function post(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      ...headers
    },
    body: JSON.stringify(body)
  });
}

// Reads a JSON or single-event SSE response body.
async function readJson(res) {
  const text = await res.text();
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const line = text.split('\n').find(l => l.startsWith('data: '));
    return JSON.parse(line.slice(6));
  }
  return JSON.parse(text);
}

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'http-eras', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {}
};
const modernHeaders = (method, name) => ({
  'MCP-Protocol-Version': MODERN,
  'Mcp-Method': method,
  ...(name ? { 'Mcp-Name': name } : {})
});

const PORT = 39000 + Math.floor(Math.random() * 500);
const server = await startServer(PORT);
try {
  // --- SDK v2 client, auto negotiation -> modern era
  {
    const client = new Client({ name: 'eras-auto', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
    }));
    assert.strictEqual(client.getProtocolEra(), 'modern');
    const { tools } = await client.listTools();
    assert.ok(tools.length > 100, `tools/list returned ${tools.length}`);
    const about = await client.callTool({ name: 'about', arguments: {} });
    assert.ok(!about.isError && about.content[0].text.length > 0);
    await client.close();
    ok(`v2 client auto -> modern era, ${tools.length} tools, about tool works`);
  }

  // --- SDK v2 client, legacy mode (2025 initialize handshake)
  {
    const client = new Client({ name: 'eras-legacy', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
    }));
    assert.strictEqual(client.getProtocolEra(), 'legacy');
    const { tools } = await client.listTools();
    const about = await client.callTool({ name: 'about', arguments: {} });
    assert.ok(tools.length > 100 && !about.isError);
    await client.close();
    ok(`v2 client legacy -> legacy era, ${tools.length} tools, about tool works`);
  }

  // --- Raw legacy: initialize mints no session id; later calls need none
  {
    const init = await post(PORT, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'raw', version: '1' } }
    });
    assert.strictEqual(init.status, 200);
    assert.strictEqual(init.headers.get('mcp-session-id'), null, 'legacy initialize must not mint a session id');
    const initBody = await readJson(init);
    assert.strictEqual(initBody.result.protocolVersion, LEGACY);
    const list = await post(PORT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { 'MCP-Protocol-Version': LEGACY, 'Mcp-Session-Id': 'stale-session-from-old-server' });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.headers.get('mcp-session-id'), null);
    assert.ok((await readJson(list)).result.tools.length > 100);
    ok('raw legacy: initialize gives no session id; tools/list with a stale session id still works');
  }

  // --- Raw modern: server/discover
  {
    const res = await post(PORT, { jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: modernMeta } },
      modernHeaders('server/discover'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('mcp-session-id'), null);
    const body = await readJson(res);
    assert.strictEqual(body.result.resultType, 'complete');
    assert.ok(body.result.supportedVersions.includes(MODERN));
    ok(`raw modern: server/discover complete, supports ${body.result.supportedVersions.join(', ')}`);
  }

  // --- Raw modern: tools/list carries cache hints
  {
    const res = await post(PORT, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: modernMeta } },
      modernHeaders('tools/list'));
    const body = await readJson(res);
    assert.strictEqual(body.result.resultType, 'complete');
    assert.strictEqual(body.result.ttlMs, 300000);
    assert.strictEqual(body.result.cacheScope, 'public');
    ok('raw modern: tools/list has resultType, ttlMs, cacheScope');
  }

  // --- Modern negatives
  {
    const call = (name, hdrName) => post(PORT, {
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name, arguments: {}, _meta: modernMeta }
    }, modernHeaders('tools/call', hdrName));
    let res = await call('about', 'help');
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await readJson(res)).error.code, -32020);
    ok('modern: Mcp-Name that does not match the body -> 400 / -32020');

    res = await post(PORT, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {
      _meta: { ...modernMeta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } },
    { 'MCP-Protocol-Version': '1900-01-01', 'Mcp-Method': 'tools/list' });
    assert.strictEqual(res.status, 400);
    const err = await readJson(res);
    assert.strictEqual(err.error.code, -32022);
    ok(`modern: unsupported version -> 400 / -32022 (supported: ${JSON.stringify(err.error.data?.supported)})`);
  }

  // --- HTTP-level rules
  {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers.get('allow'), 'POST');
    }
    ok('GET and DELETE /mcp -> 405 Allow: POST');

    let res = await post(PORT, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: modernMeta } },
      { ...modernHeaders('tools/list'), Origin: 'https://evil.example' });
    assert.strictEqual(res.status, 403);
    res = await post(PORT, { jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: modernMeta } },
      { ...modernHeaders('tools/list'), Origin: 'https://claude.ai' });
    assert.strictEqual(res.status, 200);
    ok('Origin: unknown site -> 403, claude.ai -> 200');

    res = await post(PORT, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, { Authorization: 'Bearer wrong' });
    assert.strictEqual(res.status, 401);
    ok('wrong bearer token -> 401');

    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    assert.strictEqual(health.transport, 'stateless');
    assert.deepStrictEqual(health.protocolEras, ['modern', 'legacy']);
    assert.strictEqual(health.sessions, undefined);
    ok('/health: stateless, both eras, no session count');
  }
} finally {
  server.kill();
}

// --- Modern-only switch: MCP_LEGACY=reject
{
  const port = PORT + 1;
  const strict = await startServer(port, { MCP_LEGACY: 'reject' });
  try {
    const res = await post(port, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'raw', version: '1' } }
    });
    const body = await readJson(res);
    assert.ok(body.error, 'legacy initialize must be rejected');
    const disc = await post(port, { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: modernMeta } },
      modernHeaders('server/discover'));
    assert.strictEqual(disc.status, 200);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepStrictEqual(health.protocolEras, ['modern']);
    ok(`MCP_LEGACY=reject: initialize rejected (code ${body.error.code}), modern still served`);
  } finally {
    strict.kill();
  }
}

console.log(`\nhttp-eras: ${pass} passed`);
