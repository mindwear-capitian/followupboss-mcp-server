#!/usr/bin/env node
/**
 * MCP error-semantic regression tests. Uses an in-memory MCP transport and a
 * mocked axios instance; no real FUB request is made.
 */
import assert from 'assert';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const API_KEY = 'fka_test_secret_value';
process.env.FUB_API_KEY = API_KEY;

let scenario = 'success';
let callCount = 0;

function apiError(status, message, details = {}) {
  const error = new Error(message);
  error.response = {
    status,
    headers: { 'retry-after': '0' },
    data: { errorMessage: message, ...details }
  };
  return error;
}

axios.create = () => ({
  async get() {
    callCount++;
    if (scenario === 'success') return { data: { id: 7, name: 'Test Account' } };
    if (scenario === '401') throw apiError(401, `Invalid key ${API_KEY}`, {
      apiKey: API_KEY,
      nested: { accessToken: 'provider-token' }
    });
    if (scenario === '403') throw apiError(403, 'Owner permission required');
    if (scenario === '429') throw apiError(429, 'Rate limit exhausted');
    if (scenario === 'network') throw new Error(`socket failed for ${API_KEY}`);
    throw new Error(`Unexpected scenario: ${scenario}`);
  }
});

const { createServer, handleToolCall } = await import('../index.js');
const server = createServer();
const client = new Client({ name: 'mcp-error-test', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return { response, body: JSON.parse(response.content[0].text) };
}

scenario = 'success';
let result = await call('getIdentity');
assert.strictEqual(result.response.isError, undefined, 'ordinary success must not set isError');
assert.deepStrictEqual(result.body, { id: 7, name: 'Test Account' });

scenario = '401';
result = await call('getIdentity');
assert.strictEqual(result.response.isError, true, '401 must set isError');
assert.strictEqual(result.body.status, 401);
assert.doesNotMatch(JSON.stringify(result.body), new RegExp(API_KEY), 'errors must redact configured secrets');
assert.strictEqual(result.body.details.nested.accessToken, '[REDACTED]', 'credential-like fields must be redacted');

scenario = '403';
result = await call('getIdentity');
assert.strictEqual(result.response.isError, true, '403 must set isError');
assert.strictEqual(result.body.status, 403);
assert.match(result.body.hint, /account owner permissions/);

scenario = '429';
callCount = 0;
result = await call('getPersonByEmail', { email: 'test@example.com' });
assert.strictEqual(result.response.isError, true, 'exhausted 429 retries must set isError');
assert.strictEqual(result.body.status, 429);
assert.strictEqual(callCount, 4, '429 handling must stop after the configured retry budget');

scenario = 'network';
result = await call('getIdentity');
assert.strictEqual(result.response.isError, true, 'network failure must set isError');
assert.doesNotMatch(result.body.error, new RegExp(API_KEY), 'network errors must redact configured secrets');

result = await call('notARealTool');
assert.strictEqual(result.response.isError, true, 'unknown tools must set isError');
assert.deepStrictEqual(result.body, { error: 'Unknown tool: notARealTool' });

scenario = '403';
const directResult = await handleToolCall('getIdentity', {});
assert.deepStrictEqual(directResult, {
  error: 'Owner permission required',
  status: 403,
  details: { errorMessage: 'Owner permission required' },
  hint: directResult.hint
}, 'direct import callers keep the existing plain-object error shape');

await client.close();
console.log('mcp-errors: success and error semantics passed with mocked HTTP');
