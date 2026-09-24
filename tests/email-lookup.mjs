#!/usr/bin/env node
/**
 * getPersonByEmail regression tests. Uses a mocked axios instance and never
 * contacts the Follow Up Boss API.
 */
import assert from 'assert';
import axios from 'axios';

process.env.FUB_API_KEY = 'fka_test';

let responseData;
const requests = [];
axios.create = () => ({
  async get(path, options) {
    requests.push({ path, options });
    return { data: responseData };
  }
});

const { handleToolCall } = await import('../index.js');

responseData = { people: [], _metadata: { total: 0 } };
let result = await handleToolCall('getPersonByEmail', { email: 'nobody@example.com' });
assert.deepStrictEqual(result, {
  found: false,
  message: 'No person found with email nobody@example.com'
});

const onlyPerson = {
  id: 101,
  name: 'Ada Lovelace',
  stage: 'Lead',
  emails: [{ value: 'ada@example.com' }]
};
responseData = { people: [onlyPerson], _metadata: { total: 1 } };
result = await handleToolCall('getPersonByEmail', { email: 'ada@example.com' });
assert.deepStrictEqual(result, { found: true, person: onlyPerson },
  'a unique match must preserve the existing result shape');

responseData = {
  people: [
    { id: 201, name: 'Alex Smith', stage: 'Lead', emails: [{ value: 'shared@example.com' }] },
    { id: 202, name: 'Alex Smith', stage: 'Past Client', emails: [{ value: 'shared@example.com' }] }
  ],
  _metadata: { total: 3 }
};
result = await handleToolCall('getPersonByEmail', { email: 'shared@example.com' });
assert.deepStrictEqual(result, {
  found: false,
  ambiguous: true,
  message: 'Multiple people found with email shared@example.com; choose a person ID before continuing',
  matchCount: 3,
  candidates: [
    { id: 201, name: 'Alex Smith' },
    { id: 202, name: 'Alex Smith' }
  ]
}, 'multiple matches must return minimal candidate identifiers without choosing one');

responseData = {
  people: [{ id: 301, name: 'Visible Candidate' }],
  _metadata: { total: 4 }
};
result = await handleToolCall('getPersonByEmail', { email: 'truncated@example.com' });
assert.strictEqual(result.ambiguous, true,
  'metadata must prevent a truncated response from being mistaken for a unique match');
assert.strictEqual(result.matchCount, 4);
assert.deepStrictEqual(result.candidates, [{ id: 301, name: 'Visible Candidate' }]);

assert.deepStrictEqual(requests.map(request => request.options.params), [
  { email: 'nobody@example.com', limit: 2 },
  { email: 'ada@example.com', limit: 2 },
  { email: 'shared@example.com', limit: 2 },
  { email: 'truncated@example.com', limit: 2 }
], 'lookups must request enough rows to detect ambiguity');

console.log('email-lookup: zero, one, and multiple-match behavior passed with mocked HTTP');
