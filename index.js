#!/usr/bin/env node

/*!
 * Follow Up Boss MCP Server
 *
 * A Model Context Protocol server providing 160 tools for the
 * Follow Up Boss CRM API. Self-host for free; ask before reselling.
 *
 * Copyright (c) 2026 Ed Neuhaus / Neuhaus Realty Group, LLC
 * https://neuhausre.com — Real estate broker, Austin TX (since 2007)
 * https://github.com/mindwear-capitian/followupboss-mcp-server
 *
 * Licensed under the Elastic License 2.0 — see LICENSE
 *
 * Other things by Ed: NeuhausRE.com, StaySTRA.com,
 * mls.neuhausre.com (MLS MCP), Kendall Creek Properties.
 *
 * Real estate referral in any state? https://neuhausre.com/contact
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import express from 'express';
import { readFileSync } from 'fs';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Load .env file if present (for standalone testing)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envPath = resolve(__dirname, '.env');
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // No .env file -- that's fine, env vars come from MCP host config
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FUB_API_KEY = process.env.FUB_API_KEY;
if (!FUB_API_KEY) {
  console.error('ERROR: FUB_API_KEY environment variable is required.');
  console.error('Run "npm run setup" to configure, or set FUB_API_KEY in your environment.');
  process.exit(1);
}
// Catch the classic mistake: a setup wizard or stale shell exported the
// placeholder string. Without this check the server starts but every API
// call returns 401 Invalid API Key, which is hard to diagnose.
if (/^(YOUR_KEY_HERE|your_api_key_here|placeholder|changeme)$/i.test(FUB_API_KEY)) {
  console.error(`ERROR: FUB_API_KEY is set to a placeholder value ("${FUB_API_KEY}").`);
  console.error('Set it to a real FUB API key (starts with "fka_") in your .env or MCP host config.');
  console.error('Note: shell-exported env vars override .env. Unset the placeholder first: `unset FUB_API_KEY`.');
  process.exit(1);
}

export const FUB_SAFE_MODE = process.env.FUB_SAFE_MODE === 'true';
const FUB_BASE_URL = 'https://api.followupboss.com/v1';
const FUB_SYSTEM = process.env.FUB_SYSTEM || '';
const FUB_SYSTEM_KEY = process.env.FUB_SYSTEM_KEY || '';

const fubApi = axios.create({
  baseURL: FUB_BASE_URL,
  auth: { username: FUB_API_KEY, password: '' },
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(FUB_SYSTEM ? { 'X-System': FUB_SYSTEM } : {}),
    ...(FUB_SYSTEM_KEY ? { 'X-System-Key': FUB_SYSTEM_KEY } : {})
  }
});

// MCP orchestration / internal params that must NEVER be forwarded to FUB API.
// FUB returns 400 if any unknown field is in the body.
const META_PARAM_KEYS = new Set([
  'wait_for_previous',
  '_meta',
  '__mcp',
  '__progressToken'
]);

function stripMetaParams(args) {
  if (!args || typeof args !== 'object') return args;
  const cleaned = {};
  for (const [k, v] of Object.entries(args)) {
    if (META_PARAM_KEYS.has(k)) continue;
    cleaned[k] = v;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Schema translators — accept legacy tool-arg names, emit FUB-canonical fields.
// Lets older agents keep working while sending FUB exactly what it expects.
// ---------------------------------------------------------------------------

function translateCallArgs(args) {
  const { direction, notes, occurredAt, ...rest } = args;
  const out = { ...rest };
  if (direction !== undefined && out.isIncoming === undefined) {
    const d = String(direction).toLowerCase();
    out.isIncoming = (d === 'inbound' || d === 'incoming' || d === 'in');
  }
  if (notes !== undefined && out.note === undefined) {
    out.note = notes;
  }
  // occurredAt is not in FUB's create-call body; drop it.
  return out;
}

function translateDealArgs(args) {
  const { personId, value, ...rest } = args;
  const out = { ...rest };
  if (personId !== undefined && out.peopleIds === undefined) {
    out.peopleIds = Array.isArray(personId) ? personId : [personId];
  }
  if (value !== undefined && out.price === undefined) {
    out.price = value;
  }
  // FUB now uses correctly-spelled agentCommission/teamCommission and REJECTS
  // the old misspelled fields with HTTP 400 (verified live 2026-06-06). Pass
  // the schema field names straight through unchanged.
  return out;
}

function translateDealCustomFieldArgs(args) {
  const { name, options, ...rest } = args;
  const out = { ...rest };
  if (name !== undefined && out.label === undefined) {
    out.label = name;
  }
  if (options !== undefined && out.choices === undefined) {
    out.choices = options;
  }
  return out;
}

function requireWebhookCreds() {
  if (!FUB_SYSTEM || !FUB_SYSTEM_KEY) {
    throw new Error(
      'Webhook endpoints require X-System + X-System-Key headers. Set FUB_SYSTEM and FUB_SYSTEM_KEY env vars to your registered third-party system name and key. Webhook creation is restricted to FUB account owners and registered systems.'
    );
  }
}

// FUB marks many endpoints "Restricted - Registered Systems Only" — they
// require X-System + X-System-Key, identical to webhooks. Generalized guard:
function requireSystemCreds(toolName) {
  if (!FUB_SYSTEM || !FUB_SYSTEM_KEY) {
    throw new Error(
      `${toolName} requires X-System + X-System-Key headers (FUB marks this endpoint "Restricted - Registered Systems Only"). Set FUB_SYSTEM and FUB_SYSTEM_KEY env vars to your registered third-party system name and key. See https://docs.followupboss.com/reference#identification to register.`
    );
  }
}

function translateRelationshipArgs(args) {
  // Legacy callers used relatedPersonId + relationshipType. FUB actually models
  // relationships as a new contact record attached to one personId via `type`.
  // Strip relatedPersonId (no longer meaningful) and rename relationshipType → type.
  const { relatedPersonId, relationshipType, notes, ...rest } = args;
  const out = { ...rest };
  if (relationshipType !== undefined && out.type === undefined) {
    out.type = relationshipType;
  }
  // relatedPersonId + notes have no FUB equivalent on this endpoint; drop them.
  return out;
}

function translateAppointmentArgs(args) {
  const {
    startTime, endTime, appointmentTypeId, appointmentOutcomeId, personId,
    ...rest
  } = args;
  const out = { ...rest };
  if (startTime !== undefined && out.start === undefined) out.start = startTime;
  if (endTime !== undefined && out.end === undefined) out.end = endTime;
  if (appointmentTypeId !== undefined && out.typeId === undefined) out.typeId = appointmentTypeId;
  if (appointmentOutcomeId !== undefined && out.outcomeId === undefined) out.outcomeId = appointmentOutcomeId;
  if (personId !== undefined) {
    const list = Array.isArray(out.invitees) ? [...out.invitees] : [];
    list.push({ type: 'person', id: personId });
    out.invitees = list;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Retry logic for rate limiting (429)
// ---------------------------------------------------------------------------

async function fubApiWithRetry(method, ...methodArgs) {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fubApi[method](...methodArgs);
    } catch (error) {
      if (error.response?.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(error.response.headers['retry-after'] || '2', 10);
        const wait = Math.min(retryAfter * 1000, 10000) * (attempt + 1);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleApiError(error) {
  if (error.response) {
    return {
      error: error.response.data?.errorMessage || error.response.data?.error?.errorMessage || error.message,
      status: error.response.status,
      details: error.response.data
    };
  }
  return { error: error.message };
}

// ---------------------------------------------------------------------------
// Tool Definitions (160 tools — 152 core + 5 convenience + 2 meta)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [

// ==================== EVENTS ====================
{
  "name": "listEvents",
  "description": "List events from FUB. Filter by personId, type, property address, etc.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "personId": { "type": "number", "description": "Filter by person ID" },
      "type": { "type": "string", "description": "Filter by event type" },
      "hasProperty": { "type": "boolean", "description": "Filter events that have property data" },
      "propertyAddress": { "type": "string", "description": "Filter by property address" }
    },
    "required": []
  }
},
{
  "name": "createEvent",
  "description": "Create a new event in FUB (lead event, property inquiry, etc)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "source": { "type": "string", "description": "Source of the event (e.g. website name)" },
      "system": { "type": "string", "description": "System identifier" },
      "type": { "type": "string", "description": "Event type (e.g. Registration, Property Inquiry, General Inquiry)" },
      "message": { "type": "string", "description": "Event message" },
      "description": { "type": "string", "description": "Event description" },
      "occurredAt": { "type": "string", "description": "ISO 8601 timestamp when event occurred" },
      "person": { "type": "object", "description": "Person data: {id, firstName, lastName, stage, source, sourceUrl, contacted, price, assignedTo, assignedUserId, assignedLenderId, assignedLenderName, emails:[], phones:[], addresses:[], tags:[], custom*}" },
      "property": { "type": "object", "description": "Property data: {street, city, state, code, mlsNumber, price, forRent, url, type, bedrooms, bathrooms, area, lot}" },
      "propertySearch": { "type": "object", "description": "Property search criteria: {type, neighborhood, city, state, code, minPrice, maxPrice, minBedrooms, maxBedrooms, minBathrooms, maxBathrooms}" },
      "campaign": { "type": "object", "description": "Campaign tracking: {source, medium, term, content, campaign}" },
      "pageTitle": { "type": "string", "description": "Title of the page where event occurred" },
      "pageUrl": { "type": "string", "description": "URL of the page where event occurred" },
      "pageReferrer": { "type": "string", "description": "Referrer URL" },
      "pageDuration": { "type": "number", "description": "Time spent on page in seconds" }
    },
    "required": []
  }
},
{
  "name": "getEvent",
  "description": "Get a single event by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Event ID" }
    },
    "required": ["id"]
  }
},

// ==================== PEOPLE ====================
{
  "name": "listPeople",
  "description": "List/search people in FUB. Supports filtering by name, email, phone, tags, stage, source, assignedTo, price range, smart list, and more. For tag filtering use the tags parameter (comma-separated, OR logic). For email lookup use the email parameter.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "Comma-separated person IDs" },
      "sort": { "type": "string", "description": "Sort order" },
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "fields": { "type": "string", "description": "Comma-separated list of fields to return" },
      "lastActivityAfter": { "type": "string", "description": "ISO date - only people with activity after this date" },
      "lastActivityBefore": { "type": "string", "description": "ISO date - only people with activity before this date" },
      "name": { "type": "string", "description": "Search by name" },
      "firstName": { "type": "string", "description": "Filter by first name" },
      "lastName": { "type": "string", "description": "Filter by last name" },
      "email": { "type": "string", "description": "Filter by email" },
      "phone": { "type": "string", "description": "Filter by phone" },
      "stage": { "type": "string", "description": "Filter by stage" },
      "source": { "type": "string", "description": "Filter by source" },
      "assignedTo": { "type": "string", "description": "Filter by assigned agent name" },
      "assignedUserId": { "type": "number", "description": "Filter by assigned user ID" },
      "assignedPondId": { "type": "number", "description": "Filter by assigned pond ID" },
      "assignedLenderName": { "type": "string", "description": "Filter by lender name" },
      "assignedLenderId": { "type": "number", "description": "Filter by lender ID" },
      "contacted": { "type": "boolean", "description": "Filter by contacted status" },
      "priceAbove": { "type": "number", "description": "Minimum price filter" },
      "priceBelow": { "type": "number", "description": "Maximum price filter" },
      "smartListId": { "type": "number", "description": "Filter by smart list ID" },
      "includeTrash": { "type": "boolean", "description": "Include trashed people" },
      "includeUnclaimed": { "type": "boolean", "description": "Include unclaimed people" },
      "tags": { "type": "string", "description": "Comma-separated tags to filter by" }
    },
    "required": []
  }
},
{
  "name": "createPerson",
  "description": "Create a new person/contact in FUB",
  "inputSchema": {
    "type": "object",
    "properties": {
      "deduplicate": { "type": "boolean", "description": "Check for duplicates before creating (query param)" },
      "createdAt": { "type": "string", "description": "ISO timestamp for creation date" },
      "firstName": { "type": "string", "description": "First name" },
      "lastName": { "type": "string", "description": "Last name" },
      "stage": { "type": "string", "description": "Pipeline stage" },
      "source": { "type": "string", "description": "Lead source" },
      "sourceUrl": { "type": "string", "description": "Source URL" },
      "contacted": { "type": "boolean", "description": "Whether person has been contacted" },
      "price": { "type": "number", "description": "Price point" },
      "assignedTo": { "type": "string", "description": "Assigned agent name" },
      "assignedUserId": { "type": "number", "description": "Assigned user ID" },
      "assignedPondId": { "type": "number", "description": "Assigned pond ID" },
      "assignedLenderName": { "type": "string", "description": "Assigned lender name" },
      "assignedLenderId": { "type": "number", "description": "Assigned lender ID" },
      "emails": { "type": "array", "description": "Email addresses: [{value, type}]", "items": { "type": "object" } },
      "phones": { "type": "array", "description": "Phone numbers: [{value, type}]", "items": { "type": "object" } },
      "addresses": { "type": "array", "description": "Addresses: [{street, city, state, code, type}]", "items": { "type": "object" } },
      "tags": { "type": "array", "description": "Tags to apply", "items": { "type": "string" } },
      "background": { "type": "string", "description": "Background info" },
      "collaborators": { "type": "array", "description": "Collaborator user IDs", "items": { "type": "number" } },
      "timeframeId": { "type": "number", "description": "Timeframe ID" }
    },
    "required": []
  }
},
{
  "name": "getPerson",
  "description": "Get a single person by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Person ID" },
      "fields": { "type": "string", "description": "Comma-separated list of fields to return" }
    },
    "required": ["id"]
  }
},
{
  "name": "updatePerson",
  "description": "Update an existing person in FUB",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Person ID to update" },
      "mergeTags": { "type": "boolean", "description": "Merge tags instead of replacing (query param)" },
      "firstName": { "type": "string", "description": "First name" },
      "lastName": { "type": "string", "description": "Last name" },
      "stage": { "type": "string", "description": "Pipeline stage" },
      "contacted": { "type": "boolean", "description": "Contacted status" },
      "price": { "type": "number", "description": "Price point" },
      "assignedTo": { "type": "string", "description": "Assigned agent name" },
      "assignedUserId": { "type": "number", "description": "Assigned user ID" },
      "assignedPondId": { "type": "number", "description": "Assigned pond ID" },
      "assignedLenderName": { "type": "string", "description": "Assigned lender name" },
      "assignedLenderId": { "type": "number", "description": "Assigned lender ID" },
      "emails": { "type": "array", "description": "Email addresses: [{value, type}]", "items": { "type": "object" } },
      "phones": { "type": "array", "description": "Phone numbers: [{value, type}]", "items": { "type": "object" } },
      "addresses": { "type": "array", "description": "Addresses: [{street, city, state, code, type}]", "items": { "type": "object" } },
      "tags": { "type": "array", "description": "Tags", "items": { "type": "string" } },
      "background": { "type": "string", "description": "Background info" },
      "timeframeId": { "type": "number", "description": "Timeframe ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "deletePerson",
  "description": "Delete (trash) a person by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Person ID to delete" }
    },
    "required": ["id"]
  }
},
{
  "name": "checkDuplicate",
  "description": "Check if a person already exists by email or phone",
  "inputSchema": {
    "type": "object",
    "properties": {
      "email": { "type": "string", "description": "Email to check" },
      "phone": { "type": "string", "description": "Phone to check" }
    },
    "required": []
  }
},
{
  "name": "listUnclaimed",
  "description": "List unclaimed people (in ponds, not assigned)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": []
  }
},
{
  "name": "claimPerson",
  "description": "Claim an unclaimed person",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID to claim" }
    },
    "required": ["personId"]
  }
},

// ==================== PERSON ATTACHMENTS ====================
{
  "name": "createPersonAttachment",
  "description": "Attach an externally-hosted file to a person. \"Restricted - Registered Systems Only\": requires FUB_SYSTEM + FUB_SYSTEM_KEY env vars. `uri` must point to an externally hosted file — FUB does NOT host uploads via this endpoint (omitting URI returns 403).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "uri": { "type": "string", "description": "File URI" },
      "fileName": { "type": "string", "description": "File name" },
      "fileSize": { "type": "number", "description": "File size in bytes" }
    },
    "required": ["personId", "uri", "fileName"]
  }
},
{
  "name": "getPersonAttachment",
  "description": "Get a person attachment by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Attachment ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updatePersonAttachment",
  "description": "Update a person attachment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Attachment ID" },
      "personId": { "type": "number", "description": "Person ID" },
      "uri": { "type": "string", "description": "File URI" },
      "fileName": { "type": "string", "description": "File name" },
      "fileSize": { "type": "number", "description": "File size" }
    },
    "required": ["id", "personId", "uri", "fileName"]
  }
},
{
  "name": "deletePersonAttachment",
  "description": "Delete a person attachment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Attachment ID" }
    },
    "required": ["id"]
  }
},

// ==================== PEOPLE RELATIONSHIPS ====================
{
  "name": "listRelationships",
  "description": "List relationships for a person",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": []
  }
},
{
  "name": "createRelationship",
  "description": "Create a relationship contact (Spouse, Brother, Partner, etc.) for an existing person. The relationship is its own contact record linked to personId — it is NOT a link between two existing people.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID this relationship is associated with" },
      "firstName": { "type": "string", "description": "First name of the relationship contact" },
      "lastName": { "type": "string", "description": "Last name of the relationship contact" },
      "type": { "type": "string", "description": "Relationship type (e.g. Spouse, Brother, Partner)" },
      "emails": { "type": "array", "description": "Email addresses [{type, value}]", "items": { "type": "object" } },
      "phones": { "type": "array", "description": "Phone numbers [{type, value}]", "items": { "type": "object" } },
      "addresses": { "type": "array", "description": "Mailing addresses [{type, street, city, state, code, country}]", "items": { "type": "object" } }
    },
    "required": ["personId"]
  }
},
{
  "name": "getRelationship",
  "description": "Get a relationship by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Relationship ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateRelationship",
  "description": "Update a relationship contact",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Relationship ID" },
      "firstName": { "type": "string" },
      "lastName": { "type": "string" },
      "type": { "type": "string", "description": "Relationship type (e.g. Spouse)" },
      "emails": { "type": "array", "items": { "type": "object" } },
      "phones": { "type": "array", "items": { "type": "object" } },
      "addresses": { "type": "array", "items": { "type": "object" } }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteRelationship",
  "description": "Delete a relationship",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Relationship ID" }
    },
    "required": ["id"]
  }
},

// ==================== IDENTITY ====================
{
  "name": "getIdentity",
  "description": "Get identity/account information for the API key",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "getCurrentUser",
  "description": "Get the current authenticated user (GET /me)",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},

// ==================== NOTES ====================
{
  "name": "listNotes",
  "description": "List notes, optionally filtered by personId",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Filter notes by person ID" },
      "limit": { "type": "number", "description": "Max results to return" },
      "offset": { "type": "number", "description": "Pagination offset" }
    },
    "required": []
  }
},
{
  "name": "createNote",
  "description": "Create a note on a person",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "body": { "type": "string", "description": "Note body/content" },
      "userId": { "type": "number", "description": "User ID who created the note" },
      "createdAt": { "type": "string", "description": "ISO timestamp" }
    },
    "required": ["personId", "body"]
  }
},
{
  "name": "getNote",
  "description": "Get a note by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Note ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateNote",
  "description": "Update a note",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Note ID" },
      "body": { "type": "string", "description": "Updated note body" }
    },
    "required": ["id", "body"]
  }
},
{
  "name": "deleteNote",
  "description": "Delete a note",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Note ID" }
    },
    "required": ["id"]
  }
},

// ==================== CALLS ====================
{
  "name": "listCalls",
  "description": "List calls",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "personId": { "type": "number", "description": "Filter by person ID" }
    },
    "required": []
  }
},
{
  "name": "createCall",
  "description": "Log a call for a person. FUB expects isIncoming (boolean) and note (singular).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "phone": { "type": "string", "description": "Phone number on the call" },
      "isIncoming": { "type": "boolean", "description": "true = inbound, false = outbound" },
      "duration": { "type": "number", "description": "Call duration in seconds" },
      "note": { "type": "string", "description": "Call note" },
      "outcome": { "type": "string", "description": "Call outcome" },
      "userId": { "type": "number", "description": "User who made the call" },
      "toNumber": { "type": "string", "description": "Destination number" },
      "fromNumber": { "type": "string", "description": "Originating number" },
      "recordingUrl": { "type": "string", "description": "Recording URL" }
    },
    "required": ["personId"]
  }
},
{
  "name": "getCall",
  "description": "Get a call by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Call ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateCall",
  "description": "Update a call record",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Call ID" },
      "personId": { "type": "number", "description": "Person ID" },
      "phone": { "type": "string", "description": "Phone number" },
      "isIncoming": { "type": "boolean", "description": "true = inbound" },
      "duration": { "type": "number", "description": "Duration" },
      "userId": { "type": "number", "description": "User ID" },
      "note": { "type": "string", "description": "Note" },
      "outcome": { "type": "string", "description": "Outcome" },
      "toNumber": { "type": "string" },
      "fromNumber": { "type": "string" },
      "recordingUrl": { "type": "string" }
    },
    "required": ["id"]
  }
},

// ==================== TEXT MESSAGES ====================
{
  "name": "listTextMessages",
  "description": "List text messages. FUB REQUIRES at least one filter: personId, threadId, phone, toNumber, fromNumber, sharedInboxId, groupTextId, participants, or id list. Unfiltered calls return 400.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "personId": { "type": "number", "description": "Filter by person ID" },
      "threadId": { "type": "string", "description": "Filter by thread ID" },
      "phone": { "type": "string", "description": "Filter by phone" },
      "toNumber": { "type": "string", "description": "Filter by destination number" },
      "fromNumber": { "type": "string", "description": "Filter by source number" },
      "sharedInboxId": { "type": "number", "description": "Filter by shared inbox" },
      "groupTextId": { "type": "number", "description": "Filter by group text" },
      "participants": { "type": "string", "description": "Comma-separated participants" },
      "id": { "type": "string", "description": "Comma-separated message IDs" }
    },
    "required": []
  }
},
{
  "name": "createTextMessage",
  "description": "LOG a text message that was already sent by your registered third-party SMS system. This endpoint does NOT actually deliver an SMS — FUB only records it as a log entry on the person. \"Restricted - Registered Systems Only\": requires FUB_SYSTEM + FUB_SYSTEM_KEY env vars. To actually send an SMS to a lead, do it from FUB's UI or use your SMS provider's API directly.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId":      { "type": "number", "description": "Person ID" },
      "message":       { "type": "string", "description": "Message body" },
      "toNumber":      { "type": "string", "description": "Recipient phone number" },
      "fromNumber":    { "type": "string", "description": "Sender phone number" },
      "isIncoming":    { "type": "boolean", "description": "true = inbound to your user; default false" },
      "externalLabel": { "type": "string", "description": "Label shown to the user (e.g. 'My SMS App')" },
      "externalUrl":   { "type": "string", "description": "Link to view the original message in your system" }
    },
    "required": ["personId", "message"]
  }
},
{
  "name": "getTextMessage",
  "description": "Get a text message by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Text message ID" }
    },
    "required": ["id"]
  }
},

// ==================== USERS ====================
{
  "name": "listUsers",
  "description": "List all users/agents in the account",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "sort": { "type": "string", "description": "Sort order" },
      "fields": { "type": "string", "description": "Comma-separated list of fields to return" },
      "id": { "type": "string", "description": "Comma-separated user IDs" }
    },
    "required": []
  }
},
{
  "name": "getUser",
  "description": "Get a user by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "User ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteUser",
  "description": "Delete a user",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "User ID" }
    },
    "required": ["id"]
  }
},

// ==================== SMART LISTS ====================
{
  "name": "listSmartLists",
  "description": "List all smart lists. By default only classic FUB smart lists are returned. Pass `all: true` to also include smart lists created in the current FUB UI (otherwise modern smart lists are invisible).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "fub2": { "type": "boolean", "description": "Return smart lists created in FUB's current UI. By default only classic smart lists are returned." },
      "all": { "type": "boolean", "description": "Return all smart lists from both FUB Classic and current FUB. Use this to see all user-created smart lists." }
    },
    "required": []
  }
},
{
  "name": "getSmartList",
  "description": "Get a smart list by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Smart list ID" }
    },
    "required": ["id"]
  }
},

// ==================== ACTION PLANS ====================
{
  "name": "listActionPlans",
  "description": "List all action plans",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": []
  }
},
{
  "name": "listActionPlansPeople",
  "description": "List people assigned to action plans",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Filter by person ID" },
      "actionPlanId": { "type": "number", "description": "Filter by action plan ID" },
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": []
  }
},
{
  "name": "addPersonToActionPlan",
  "description": "Add a person to an action plan",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "actionPlanId": { "type": "number", "description": "Action plan ID" }
    },
    "required": ["personId", "actionPlanId"]
  }
},
{
  "name": "updateActionPlanPerson",
  "description": "Update a person's action plan status",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "ActionPlanPerson ID" },
      "status": { "type": "string", "description": "New status" }
    },
    "required": ["id"]
  }
},

// ==================== AUTOMATIONS ====================
{
  "name": "listAutomations",
  "description": "List all Automations 2.0 automations. \"Restricted - Registered Systems Only\": requires FUB_SYSTEM + FUB_SYSTEM_KEY. Account must also be on Automations 2.0.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": []
  }
},
{
  "name": "getAutomation",
  "description": "Get an automation by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Automation ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "listAutomationsPeople",
  "description": "List people in Automations 2.0 automations. \"Restricted - Registered Systems Only\": requires FUB_SYSTEM + FUB_SYSTEM_KEY.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Filter by person" },
      "automationId": { "type": "number", "description": "Filter by automation" },
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": []
  }
},
{
  "name": "getAutomationPerson",
  "description": "Get an automation-person entry by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "AutomationPerson ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "addPersonToAutomation",
  "description": "Add a person to an automation",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "automationId": { "type": "number", "description": "Automation ID" }
    },
    "required": ["personId", "automationId"]
  }
},
{
  "name": "updateAutomationPerson",
  "description": "Update a person's automation status",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "AutomationPerson ID" },
      "status": { "type": "string", "description": "New status" }
    },
    "required": ["id"]
  }
},

// ==================== EMAIL TEMPLATES ====================
{
  "name": "listTemplates",
  "description": "List email templates",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "next": { "type": "string", "description": "Cursor for next page of results" }
    },
    "required": []
  }
},
{
  "name": "createTemplate",
  "description": "Create an email template",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Template name" },
      "subject": { "type": "string", "description": "Email subject" },
      "body": { "type": "string", "description": "Email body HTML" }
    },
    "required": ["name", "subject", "body"]
  }
},
{
  "name": "getTemplate",
  "description": "Get an email template by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Template ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateTemplate",
  "description": "Update an email template",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Template ID" },
      "name": { "type": "string", "description": "Name" },
      "subject": { "type": "string", "description": "Subject" },
      "body": { "type": "string", "description": "Body HTML" }
    },
    "required": ["id"]
  }
},
{
  "name": "mergeTemplate",
  "description": "Merge an email template with a person's data (mail merge)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "templateId": { "type": "number", "description": "Template ID" },
      "personId": { "type": "number", "description": "Person ID" }
    },
    "required": ["templateId", "personId"]
  }
},
{
  "name": "deleteTemplate",
  "description": "Delete an email template",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Template ID" }
    },
    "required": ["id"]
  }
},

// ==================== TEXT MESSAGE TEMPLATES ====================
{
  "name": "listTextMessageTemplates",
  "description": "List text message templates",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "next": { "type": "string", "description": "Cursor for next page of results" }
    },
    "required": []
  }
},
{
  "name": "createTextMessageTemplate",
  "description": "Create a text message template",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Template name" },
      "body": { "type": "string", "description": "Message body" }
    },
    "required": ["name", "body"]
  }
},
{
  "name": "getTextMessageTemplate",
  "description": "Get a text message template by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Template ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateTextMessageTemplate",
  "description": "Update a text message template",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Template ID" },
      "name": { "type": "string", "description": "Name" },
      "body": { "type": "string", "description": "Body" }
    },
    "required": ["id"]
  }
},
{
  "name": "mergeTextMessageTemplate",
  "description": "Merge a text message template with person data",
  "inputSchema": {
    "type": "object",
    "properties": {
      "templateId": { "type": "number", "description": "Template ID" },
      "personId": { "type": "number", "description": "Person ID" }
    },
    "required": ["templateId", "personId"]
  }
},
{
  "name": "deleteTextMessageTemplate",
  "description": "Delete a text message template",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Template ID" }
    },
    "required": ["id"]
  }
},

// ==================== EMAIL MARKETING ====================
{
  "name": "listEmEvents",
  "description": "List email marketing events",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": []
  }
},
{
  "name": "createEmEvent",
  "description": "Create email marketing events",
  "inputSchema": {
    "type": "object",
    "properties": {
      "campaignId": { "type": "number", "description": "Campaign ID" },
      "events": { "type": "array", "description": "Events array: [{type, email, timestamp}]", "items": { "type": "object" } }
    },
    "required": ["campaignId", "events"]
  }
},
{
  "name": "listEmCampaigns",
  "description": "List email marketing campaigns",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": []
  }
},
{
  "name": "createEmCampaign",
  "description": "Create an email marketing campaign",
  "inputSchema": {
    "type": "object",
    "properties": {
      "origin": { "type": "string", "description": "Campaign origin" },
      "originId": { "type": "string", "description": "Origin ID" },
      "subject": { "type": "string", "description": "Email subject" },
      "bodyHtml": { "type": "string", "description": "Email body HTML" }
    },
    "required": ["origin", "subject", "bodyHtml"]
  }
},
{
  "name": "updateEmCampaign",
  "description": "Update an email marketing campaign",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Campaign ID" },
      "origin": { "type": "string", "description": "Origin" },
      "originId": { "type": "string", "description": "Origin ID" },
      "subject": { "type": "string", "description": "Subject" },
      "bodyHtml": { "type": "string", "description": "Body HTML" }
    },
    "required": ["id"]
  }
},

// ==================== CUSTOM FIELDS ====================
{
  "name": "listCustomFields",
  "description": "List all custom fields",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createCustomField",
  "description": "Create a custom field",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Field name" },
      "type": { "type": "string", "description": "Field type (text, number, dropdown, etc)" },
      "options": { "type": "array", "description": "Options for dropdown fields", "items": { "type": "string" } }
    },
    "required": ["name", "type"]
  }
},
{
  "name": "getCustomField",
  "description": "Get a custom field by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Custom field ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateCustomField",
  "description": "Update a custom field",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Custom field ID" },
      "name": { "type": "string", "description": "Name" },
      "type": { "type": "string", "description": "Type" },
      "options": { "type": "array", "description": "Options", "items": { "type": "string" } }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteCustomField",
  "description": "Delete a custom field",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Custom field ID" }
    },
    "required": ["id"]
  }
},

// ==================== STAGES ====================
{
  "name": "listStages",
  "description": "List all pipeline stages",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createStage",
  "description": "Create a pipeline stage",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Stage name" },
      "pipelineId": { "type": "number", "description": "Pipeline ID" }
    },
    "required": ["name"]
  }
},
{
  "name": "getStage",
  "description": "Get a stage by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Stage ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateStage",
  "description": "Update a stage",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Stage ID" },
      "name": { "type": "string", "description": "Stage name" }
    },
    "required": ["id", "name"]
  }
},
{
  "name": "deleteStage",
  "description": "Delete a stage",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Stage ID" }
    },
    "required": ["id"]
  }
},

// ==================== TASKS ====================
{
  "name": "listTasks",
  "description": "List tasks",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "sort": { "type": "string", "description": "Sort order" },
      "fields": { "type": "string", "description": "Comma-separated list of fields to return" }
    },
    "required": []
  }
},
{
  "name": "createTask",
  "description": "Create a task",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "name": { "type": "string", "description": "Task name" },
      "dueDate": { "type": "string", "description": "Due date ISO" },
      "assignedUserId": { "type": "number", "description": "Assigned user ID" },
      "status": { "type": "string", "description": "Task status" }
    },
    "required": ["name"]
  }
},
{
  "name": "getTask",
  "description": "Get a task by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Task ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateTask",
  "description": "Update a task",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Task ID" },
      "personId": { "type": "number", "description": "Person ID" },
      "name": { "type": "string", "description": "Name" },
      "dueDate": { "type": "string", "description": "Due date" },
      "assignedUserId": { "type": "number", "description": "Assigned user" },
      "status": { "type": "string", "description": "Status" }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteTask",
  "description": "Delete a task",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Task ID" }
    },
    "required": ["id"]
  }
},

// ==================== APPOINTMENTS ====================
{
  "name": "listAppointments",
  "description": "List appointments",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "personId": { "type": "number", "description": "Filter by person" }
    },
    "required": []
  }
},
{
  "name": "createAppointment",
  "description": "Create an appointment. FUB uses start/end (not startTime/endTime), typeId/outcomeId (not appointmentTypeId/appointmentOutcomeId), and invitees:[{type:'person'|'user',id}] (personId is NOT a top-level field).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "description": "Appointment title (required)" },
      "start": { "type": "string", "description": "Start ISO 8601 (required)" },
      "end": { "type": "string", "description": "End ISO 8601 (required)" },
      "description": { "type": "string", "description": "Description" },
      "invitees": { "type": "array", "description": "Array of {type:'person'|'user', id:int}", "items": { "type": "object" } },
      "allDay": { "type": "boolean" },
      "location": { "type": "string", "description": "Location" },
      "typeId": { "type": "number", "description": "Appointment type ID" },
      "outcomeId": { "type": "number", "description": "Appointment outcome ID" },
      "createdById": { "type": "number", "description": "Creator user ID (admin only)" }
    },
    "required": ["title", "start", "end"]
  }
},
{
  "name": "getAppointment",
  "description": "Get an appointment by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Appointment ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateAppointment",
  "description": "Update an appointment. FUB requires `start` and `end` on EVERY update (even partial edits) or it returns 'Valid Start and End dates are required'. Refetch with getAppointment first if you only have the id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Appointment ID" },
      "title": { "type": "string" },
      "start": { "type": "string", "description": "Start ISO" },
      "end": { "type": "string", "description": "End ISO" },
      "description": { "type": "string" },
      "invitees": { "type": "array", "items": { "type": "object" } },
      "allDay": { "type": "boolean" },
      "location": { "type": "string" },
      "typeId": { "type": "number", "description": "Type ID" },
      "outcomeId": { "type": "number", "description": "Outcome ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteAppointment",
  "description": "Delete an appointment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Appointment ID" }
    },
    "required": ["id"]
  }
},

// ==================== APPOINTMENT TYPES ====================
{
  "name": "listAppointmentTypes",
  "description": "List appointment types",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createAppointmentType",
  "description": "Create an appointment type",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Type name" }
    },
    "required": ["name"]
  }
},
{
  "name": "getAppointmentType",
  "description": "Get appointment type by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Type ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateAppointmentType",
  "description": "Update an appointment type",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Type ID" },
      "name": { "type": "string", "description": "Name" }
    },
    "required": ["id", "name"]
  }
},
{
  "name": "deleteAppointmentType",
  "description": "Delete an appointment type",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Type ID" }
    },
    "required": ["id"]
  }
},

// ==================== APPOINTMENT OUTCOMES ====================
{
  "name": "listAppointmentOutcomes",
  "description": "List appointment outcomes",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createAppointmentOutcome",
  "description": "Create an appointment outcome",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Outcome name" }
    },
    "required": ["name"]
  }
},
{
  "name": "getAppointmentOutcome",
  "description": "Get appointment outcome by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Outcome ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateAppointmentOutcome",
  "description": "Update an appointment outcome",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Outcome ID" },
      "name": { "type": "string", "description": "Name" }
    },
    "required": ["id", "name"]
  }
},
{
  "name": "deleteAppointmentOutcome",
  "description": "Delete an appointment outcome",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Outcome ID" }
    },
    "required": ["id"]
  }
},

// ==================== WEBHOOKS ====================
{
  "name": "listWebhooks",
  "description": "List all webhooks",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createWebhook",
  "description": "Create a webhook",
  "inputSchema": {
    "type": "object",
    "properties": {
      "event": { "type": "string", "description": "Webhook event type" },
      "url": { "type": "string", "description": "Callback URL" }
    },
    "required": ["event", "url"]
  }
},
{
  "name": "getWebhook",
  "description": "Get a webhook by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Webhook ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateWebhook",
  "description": "Update a webhook",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Webhook ID" },
      "event": { "type": "string", "description": "Event type" },
      "url": { "type": "string", "description": "Callback URL" }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteWebhook",
  "description": "Delete a webhook",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Webhook ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "getWebhookEvents",
  "description": "Get events for a webhook",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Webhook ID" }
    },
    "required": ["id"]
  }
},

// ==================== PIPELINES ====================
{
  "name": "listPipelines",
  "description": "List all pipelines",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createPipeline",
  "description": "Create a pipeline",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Pipeline name" }
    },
    "required": ["name"]
  }
},
{
  "name": "getPipeline",
  "description": "Get a pipeline by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Pipeline ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updatePipeline",
  "description": "Update a pipeline",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Pipeline ID" },
      "name": { "type": "string", "description": "Name" }
    },
    "required": ["id", "name"]
  }
},
{
  "name": "deletePipeline",
  "description": "Delete a pipeline",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Pipeline ID" }
    },
    "required": ["id"]
  }
},

// ==================== DEALS ====================
{
  "name": "listDeals",
  "description": "List deals with filtering",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of results to return" },
      "offset": { "type": "number", "description": "Offset for pagination" },
      "next": { "type": "string", "description": "Cursor for next page of results" },
      "sort": { "type": "string", "description": "Sort order" },
      "fields": { "type": "string", "description": "Comma-separated list of fields to return" },
      "id": { "type": "string", "description": "Comma-separated deal IDs" },
      "pipelineId": { "type": "number", "description": "Filter by pipeline" },
      "stageId": { "type": "number", "description": "Filter by stage (numeric stage ID)" },
      "personId": { "type": "number", "description": "Return deals linked to a specific person" },
      "userId": { "type": "number", "description": "Return deals assigned to a specific user" },
      "includeArchived": { "type": "integer", "enum": [0, 1], "description": "Set to 1 to include deals with status Archived (default 0)" },
      "includeDeleted": { "type": "integer", "enum": [0, 1], "description": "Set to 1 to include deals with status Deleted (default 0)" },
      "status": { "type": "string", "enum": ["Active", "Archived"], "description": "Only return deals with this status. For deleted deals use includeDeleted=1 (the API's \"Deleted\" value does not filter — it returns all statuses)." }
    },
    "required": []
  }
},
{
  "name": "createDeal",
  "description": "Create a deal. FUB expects peopleIds (array) and price (number). name + stageId required.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Deal name" },
      "stageId": { "type": "number", "description": "Stage ID (required)" },
      "description": { "type": "string", "description": "Deal description" },
      "peopleIds": { "type": "array", "description": "Person IDs on the deal", "items": { "type": "number" } },
      "userIds": { "type": "array", "description": "Assigned user IDs", "items": { "type": "number" } },
      "price": { "type": "number", "description": "Deal price" },
      "projectedCloseDate": { "type": "string", "description": "Projected close date" },
      "orderWeight": { "type": "number", "description": "Sort order weight" },
      "commissionValue": { "type": "number" },
      "agentCommission": { "type": "number" },
      "teamCommission": { "type": "number" },
      "earnestMoneyDueDate": { "type": "string" },
      "mutualAcceptanceDate": { "type": "string" },
      "dueDiligenceDate": { "type": "string" },
      "finalWalkThroughDate": { "type": "string" },
      "possessionDate": { "type": "string" }
    },
    "required": ["name", "stageId"]
  }
},
{
  "name": "getDeal",
  "description": "Get a deal by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Deal ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateDeal",
  "description": "Update a deal. Use price (not value) and peopleIds (not personId).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Deal ID" },
      "name": { "type": "string", "description": "Name" },
      "stageId": { "type": "number", "description": "Stage ID" },
      "peopleIds": { "type": "array", "description": "People on deal", "items": { "type": "number" } },
      "userIds": { "type": "array", "description": "User IDs", "items": { "type": "number" } },
      "price": { "type": "number", "description": "Price" },
      "description": { "type": "string", "description": "Description" },
      "projectedCloseDate": { "type": "string", "description": "Projected close date (YYYY-MM-DD)" },
      "commissionValue": { "type": "integer", "description": "Total commission value" },
      "agentCommission": { "type": "integer", "description": "Agent commission split" },
      "teamCommission": { "type": "integer", "description": "Team commission split" },
      "earnestMoneyDueDate": { "type": "string", "description": "Earnest money due date (YYYY-MM-DD)" },
      "mutualAcceptanceDate": { "type": "string", "description": "Mutual acceptance date (YYYY-MM-DD)" },
      "dueDiligenceDate": { "type": "string", "description": "Due diligence date (YYYY-MM-DD)" },
      "finalWalkThroughDate": { "type": "string", "description": "Final walk-through date (YYYY-MM-DD)" },
      "possessionDate": { "type": "string", "description": "Possession date (YYYY-MM-DD)" }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteDeal",
  "description": "Delete a deal",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Deal ID" }
    },
    "required": ["id"]
  }
},

// ==================== DEAL ATTACHMENTS ====================
{
  "name": "createDealAttachment",
  "description": "Attach an externally-hosted file to a deal. \"Restricted - Registered Systems Only\": requires FUB_SYSTEM + FUB_SYSTEM_KEY env vars. `uri` must point to an externally hosted file — FUB does NOT host uploads via this endpoint (omitting URI returns 403).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "dealId": { "type": "number", "description": "Deal ID" },
      "uri": { "type": "string", "description": "File URI" },
      "fileName": { "type": "string", "description": "File name" },
      "fileSize": { "type": "number", "description": "File size" }
    },
    "required": ["dealId", "uri", "fileName"]
  }
},
{
  "name": "getDealAttachment",
  "description": "Get a deal attachment by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Attachment ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateDealAttachment",
  "description": "Update a deal attachment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Attachment ID" },
      "dealId": { "type": "number", "description": "Deal ID" },
      "uri": { "type": "string", "description": "URI" },
      "fileName": { "type": "string", "description": "File name" },
      "fileSize": { "type": "number", "description": "Size" }
    },
    "required": ["id", "dealId", "uri", "fileName"]
  }
},
{
  "name": "deleteDealAttachment",
  "description": "Delete a deal attachment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Attachment ID" }
    },
    "required": ["id"]
  }
},

// ==================== DEAL CUSTOM FIELDS ====================
{
  "name": "listDealCustomFields",
  "description": "List deal custom fields",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createDealCustomField",
  "description": "Create a deal custom field. FUB expects 'label' (not 'name') and 'choices' (not 'options').",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": { "type": "string", "description": "User-friendly field name" },
      "type": { "type": "string", "description": "Field type: text, date, number, dropdown" },
      "choices": { "type": "array", "description": "Dropdown choices (dropdown only)", "items": { "type": "string" } },
      "isRecurring": { "type": "boolean" },
      "hideIfEmpty": { "type": "boolean" },
      "orderWeight": { "type": "number" },
      "readOnly": { "type": "boolean" }
    },
    "required": ["label", "type"]
  }
},
{
  "name": "getDealCustomField",
  "description": "Get a deal custom field by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Field ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateDealCustomField",
  "description": "Update a deal custom field",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Field ID" },
      "label": { "type": "string", "description": "User-friendly field name" },
      "type": { "type": "string", "description": "Field type" },
      "choices": { "type": "array", "items": { "type": "string" } },
      "isRecurring": { "type": "boolean" },
      "hideIfEmpty": { "type": "boolean" },
      "orderWeight": { "type": "number" },
      "readOnly": { "type": "boolean" }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteDealCustomField",
  "description": "Delete a deal custom field",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Field ID" }
    },
    "required": ["id"]
  }
},

// ==================== GROUPS ====================
{
  "name": "listGroups",
  "description": "List all groups",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "listRoundRobinGroups",
  "description": "List round robin groups",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createGroup",
  "description": "Create a group",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Group name" },
      "userIds": { "type": "array", "description": "User IDs", "items": { "type": "number" } }
    },
    "required": ["name"]
  }
},
{
  "name": "getGroup",
  "description": "Get a group by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Group ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateGroup",
  "description": "Update a group",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Group ID" },
      "name": { "type": "string", "description": "Name" },
      "userIds": { "type": "array", "description": "User IDs", "items": { "type": "number" } }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteGroup",
  "description": "Delete a group",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Group ID" }
    },
    "required": ["id"]
  }
},

// ==================== TEAMS ====================
{
  "name": "listTeams",
  "description": "List all teams",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createTeam",
  "description": "Create a team",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Team name" },
      "description": { "type": "string", "description": "Team description" }
    },
    "required": ["name"]
  }
},
{
  "name": "getTeam",
  "description": "Get a team by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Team ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updateTeam",
  "description": "Update a team",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Team ID" },
      "name": { "type": "string", "description": "Name" },
      "description": { "type": "string", "description": "Description" }
    },
    "required": ["id"]
  }
},
{
  "name": "deleteTeam",
  "description": "Delete a team",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Team ID" }
    },
    "required": ["id"]
  }
},

// ==================== TEAM INBOXES ====================
{
  "name": "listTeamInboxes",
  "description": "List all team inboxes",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},

// ==================== PONDS ====================
{
  "name": "listPonds",
  "description": "List all ponds",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "createPond",
  "description": "Create a pond",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Pond name" }
    },
    "required": ["name"]
  }
},
{
  "name": "getPond",
  "description": "Get a pond by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Pond ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "updatePond",
  "description": "Update a pond",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Pond ID" },
      "name": { "type": "string", "description": "Name" }
    },
    "required": ["id", "name"]
  }
},
{
  "name": "deletePond",
  "description": "Delete a pond",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Pond ID" }
    },
    "required": ["id"]
  }
},

// ==================== TIMEFRAMES ====================
{
  "name": "listTimeframes",
  "description": "List all timeframes",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},

// ==================== INBOX APPS ====================
{
  "name": "inboxAppAddMessage",
  "description": "Add a message to an inbox app conversation",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversationId": { "type": "string", "description": "Conversation ID" },
      "message": { "type": "string", "description": "Message content" },
      "sender": { "type": "object", "description": "Sender info" },
      "timestamp": { "type": "string", "description": "ISO timestamp" }
    },
    "required": ["conversationId", "message"]
  }
},
{
  "name": "inboxAppUpdateMessage",
  "description": "Update an inbox app message",
  "inputSchema": {
    "type": "object",
    "properties": {
      "messageId": { "type": "string", "description": "Message ID" },
      "message": { "type": "string", "description": "Updated message" }
    },
    "required": ["messageId", "message"]
  }
},
{
  "name": "inboxAppAddNote",
  "description": "Add a note to an inbox app conversation",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversationId": { "type": "string", "description": "Conversation ID" },
      "note": { "type": "string", "description": "Note content" }
    },
    "required": ["conversationId", "note"]
  }
},
{
  "name": "inboxAppUpdateConversation",
  "description": "Update an inbox app conversation status",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversationId": { "type": "string", "description": "Conversation ID" },
      "status": { "type": "string", "description": "New status" }
    },
    "required": ["conversationId"]
  }
},
{
  "name": "inboxAppGetParticipants",
  "description": "Get participants of an inbox app conversation",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversationId": { "type": "string", "description": "Conversation ID" }
    },
    "required": ["conversationId"]
  }
},
{
  "name": "inboxAppCreateParticipant",
  "description": "Add a participant to an inbox app conversation",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversationId": { "type": "string", "description": "Conversation ID" },
      "personId": { "type": "number", "description": "Person ID to add" }
    },
    "required": ["conversationId", "personId"]
  }
},
{
  "name": "inboxAppDeleteParticipant",
  "description": "Remove a participant from an inbox app conversation by participant id",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Participant ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "inboxAppInstall",
  "description": "Install an inbox app for a user. Requires the publishedInboxAppId from FUB's app catalog plus a webhook subscriptionUrl.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "publishedInboxAppId": { "type": "number", "description": "Published inbox app ID from FUB catalog" },
      "userId": { "type": "number", "description": "User to install for" },
      "subscriptionUrl": { "type": "string", "description": "Webhook subscription URL" }
    },
    "required": ["publishedInboxAppId", "userId", "subscriptionUrl"]
  }
},
{
  "name": "inboxAppDeactivate",
  "description": "Deactivate an inbox app installation by ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Installation ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "listInboxAppInstallations",
  "description": "List inbox app installations. Requires a registered third-party system (FUB_SYSTEM + FUB_SYSTEM_KEY). On unregistered accounts FUB returns 404 'Requested resource was not found'.",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},

// ==================== REACTIONS ====================
{
  "name": "getReactions",
  "description": "Get reactions for an item",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Item ID" }
    },
    "required": ["id"]
  }
},
{
  "name": "createReaction",
  "description": "Create a reaction on an item",
  "inputSchema": {
    "type": "object",
    "properties": {
      "refType": { "type": "string", "description": "Reference type (e.g. note, email)" },
      "refId": { "type": "number", "description": "Reference ID" },
      "emoji": { "type": "string", "description": "Emoji reaction" }
    },
    "required": ["refType", "refId", "emoji"]
  }
},
{
  "name": "deleteReaction",
  "description": "Delete a reaction from an item",
  "inputSchema": {
    "type": "object",
    "properties": {
      "refType": { "type": "string", "description": "Reference type" },
      "refId": { "type": "number", "description": "Reference ID" }
    },
    "required": ["refType", "refId"]
  }
},

// ==================== THREADED REPLIES ====================
{
  "name": "getThreadedReplies",
  "description": "Get threaded replies for an item",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Item ID" }
    },
    "required": ["id"]
  }
}

,

// ==================== CONVENIENCE TOOLS ====================
{
  "name": "removeTagFromPerson",
  "description": "Remove a single tag from a person without affecting their other tags. Handles the read-modify-write cycle internally.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Person ID" },
      "tag": { "type": "string", "description": "Tag to remove (case-insensitive match)" }
    },
    "required": ["id", "tag"]
  }
},
{
  "name": "getPersonByEmail",
  "description": "Look up a person by email address. Returns the first matching contact.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "email": { "type": "string", "description": "Email address to look up" }
    },
    "required": ["email"]
  }
},
{
  "name": "searchPeopleByTag",
  "description": "Find all people with one or more tags. Comma-separate multiple tags for OR matching (e.g. 'Investor,Buyer' returns people with either tag).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tags": { "type": "string", "description": "Comma-separated tag(s) to search for" },
      "limit": { "type": "number", "description": "Max results (default 25, max 100)" },
      "offset": { "type": "number", "description": "Offset for pagination" }
    },
    "required": ["tags"]
  }
},
{
  "name": "bulkUpdatePeople",
  "description": "Update multiple people with the same changes. Rate-limited to stay within FUB's 25 PUTs per 10 seconds. Returns results for each person.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "ids": { "type": "array", "items": { "type": "number" }, "description": "Array of person IDs to update" },
      "mergeTags": { "type": "boolean", "description": "Merge tags instead of replacing" },
      "updates": { "type": "object", "description": "Fields to update on each person (same fields as updatePerson: tags, stage, assignedTo, etc.)" }
    },
    "required": ["ids", "updates"]
  }
},
{
  "name": "listAvailableTags",
  "description": "Discover tags used in your FUB account by scanning recent contacts. Returns unique tags sorted alphabetically. Note: scans up to 500 contacts so may not find rarely-used tags.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Number of contacts to scan (default 500, max 500)" }
    },
    "required": []
  }
},

// ==================== META (about + help) ====================
{
  "name": "about",
  "description": "Get information about this MCP server, its author, and the projects behind it. Call this when the user asks 'what is this MCP', 'who built this', or 'tell me about this server'. Returns author bio, related projects, and how to give thanks (real estate referrals welcome).",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "help",
  "description": "Get usage tips for this MCP server, common tool examples, and how to report bugs or request features. Call this when the user asks for help, examples, or how to use this MCP.",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
}

]; // end TOOL_DEFINITIONS

// ---------------------------------------------------------------------------
// Tool Handler
// ---------------------------------------------------------------------------

export async function handleToolCall(name, rawArgs) {
  const args = stripMetaParams(rawArgs);
  try {
    switch (name) {

    // ==================== META (about + help) ====================
    case 'about': {
      return {
        server: 'Follow Up Boss MCP Server',
        version: '1.3.3',
        author: {
          name: 'Ed Neuhaus',
          title: 'Broker / Owner',
          company: 'Neuhaus Realty Group, LLC',
          location: 'Austin, Texas',
          experience: '19+ years in real estate (since 2007)',
          contact: 'https://neuhausre.com/contact',
          website: 'https://neuhausre.com',
          linkedin: 'https://linkedin.com/in/edneuhaus'
        },
        why_this_exists: 'Ed built this to talk to his own FUB account in plain English. Free to self-host under the Elastic License 2.0.',
        other_projects_by_ed: {
          'NeuhausRE.com': 'My brokerage — Austin real estate with AI-powered home search',
          'StaySTRA.com': 'Short-term rental investment analyzer',
          'mls.neuhausre.com': 'MLS MCP server — live MLS data via Claude (Active Buyer retainer $200/mo)',
          'Kendall Creek Properties': 'Sister brokerage'
        },
        how_to_thank_me: [
          'Got a real estate client moving to or from Austin? Refer them. Texas real estate referrals welcome from licensed agents in any state. Reach out via https://neuhausre.com/contact.',
          'Write about this tool on your blog, LinkedIn, or X. Tag @edneuhaus and link to neuhausre.com.',
          'Open an issue or PR on GitHub if you find a bug or build something useful.'
        ],
        contributors: {
          'yoship90': 'Smart list API key fix (v1.1.2)',
          'chad778': 'OAuth + remote transport prototype (in fork chad778/followupboss-mcp-server)'
        },
        license: 'Elastic License 2.0 — see LICENSE file. Self-host free; commercial hosting/resale requires separate agreement.',
        github: 'https://github.com/mindwear-capitian/followupboss-mcp-server'
      };
    }
    case 'help': {
      return {
        server: 'Follow Up Boss MCP Server v1.2.0',
        getting_started: 'Set FUB_API_KEY in your MCP host config (Claude Desktop, Claude Code, Cline, Cursor, etc.). Run `npm run setup` for an interactive wizard.',
        common_examples: [
          '"Show me my smart lists" → listSmartLists ({all: true} to include modern UI lists)',
          '"Find duplicates of John Smith" → checkDuplicate',
          '"Create a deal for the Anderson contact" → createDeal',
          '"List my open tasks for today" → listTasks',
          '"Tag this contact as Hot Lead" → updatePerson + tag mgmt'
        ],
        safe_mode: 'FUB_SAFE_MODE=true (default) disables all 23 delete tools. Set to false only if you really need delete operations.',
        bug_reports: 'https://github.com/mindwear-capitian/followupboss-mcp-server/issues',
        feature_requests: 'PRs welcome. Or open an issue.',
        author: 'Ed Neuhaus, broker @ Neuhaus Realty Group, Austin TX. Contact: https://neuhausre.com/contact. Real estate referrals from licensed agents in any state are welcome.',
        more_info: 'Call the `about` tool for full bio + related projects.'
      };
    }

    // ==================== EVENTS ====================
    case 'listEvents': {
      const response = await fubApi.get('/events', { params: args });
      return { events: response.data.events, _metadata: response.data._metadata };
    }
    case 'createEvent': {
      const response = await fubApi.post('/events', args);
      return response.data;
    }
    case 'getEvent': {
      const response = await fubApi.get(`/events/${args.id}`);
      return response.data;
    }

    // ==================== PEOPLE ====================
    case 'listPeople': {
      const response = await fubApi.get('/people', { params: args });
      return { people: response.data.people, _metadata: response.data._metadata };
    }
    case 'createPerson': {
      const { deduplicate, ...body } = args;
      const params = deduplicate !== undefined ? { deduplicate } : {};
      const response = await fubApi.post('/people', body, { params });
      return response.data;
    }
    case 'getPerson': {
      const { id, ...params } = args;
      const response = await fubApi.get(`/people/${id}`, { params });
      return response.data;
    }
    case 'updatePerson': {
      const { id, mergeTags, ...body } = args;
      const params = mergeTags !== undefined ? { mergeTags } : {};
      const response = await fubApi.put(`/people/${id}`, body, { params });
      return response.data;
    }
    case 'deletePerson': {
      await fubApi.delete(`/people/${args.id}`);
      return { success: true, message: `Person ${args.id} deleted` };
    }
    case 'checkDuplicate': {
      const response = await fubApi.get('/people/checkDuplicate', { params: args });
      return response.data;
    }
    case 'listUnclaimed': {
      const response = await fubApi.get('/people/unclaimed', { params: args });
      return { people: response.data.people, _metadata: response.data._metadata };
    }
    case 'claimPerson': {
      const response = await fubApi.post('/people/claim', args);
      return response.data;
    }

    // ==================== PERSON ATTACHMENTS ====================
    case 'createPersonAttachment': {
      requireSystemCreds('createPersonAttachment');
      const response = await fubApi.post('/personAttachments', args);
      return response.data;
    }
    case 'getPersonAttachment': {
      const response = await fubApi.get(`/personAttachments/${args.id}`);
      return response.data;
    }
    case 'updatePersonAttachment': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/personAttachments/${id}`, body);
      return response.data;
    }
    case 'deletePersonAttachment': {
      await fubApi.delete(`/personAttachments/${args.id}`);
      return { success: true, message: `Person attachment ${args.id} deleted` };
    }

    // ==================== PEOPLE RELATIONSHIPS ====================
    case 'listRelationships': {
      const response = await fubApi.get('/peopleRelationships', { params: args });
      return { peopleRelationships: response.data.peopleRelationships || response.data.peoplerelationships, _metadata: response.data._metadata };
    }
    case 'createRelationship': {
      const body = translateRelationshipArgs(args);
      const response = await fubApi.post('/peopleRelationships', body);
      return response.data;
    }
    case 'getRelationship': {
      const response = await fubApi.get(`/peopleRelationships/${args.id}`);
      return response.data;
    }
    case 'updateRelationship': {
      const { id, ...rest } = args;
      const body = translateRelationshipArgs(rest);
      const response = await fubApi.put(`/peopleRelationships/${id}`, body);
      return response.data;
    }
    case 'deleteRelationship': {
      await fubApi.delete(`/peopleRelationships/${args.id}`);
      return { success: true, message: `Relationship ${args.id} deleted` };
    }

    // ==================== IDENTITY ====================
    case 'getIdentity': {
      const response = await fubApi.get('/identity');
      return response.data;
    }
    case 'getCurrentUser': {
      const response = await fubApi.get('/me');
      return response.data;
    }

    // ==================== NOTES ====================
    case 'listNotes': {
      const response = await fubApi.get('/notes', { params: args });
      return { notes: response.data.notes, _metadata: response.data._metadata };
    }
    case 'createNote': {
      const response = await fubApi.post('/notes', args);
      return response.data;
    }
    case 'getNote': {
      const response = await fubApi.get(`/notes/${args.id}`);
      return response.data;
    }
    case 'updateNote': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/notes/${id}`, body);
      return response.data;
    }
    case 'deleteNote': {
      await fubApi.delete(`/notes/${args.id}`);
      return { success: true, message: `Note ${args.id} deleted` };
    }

    // ==================== CALLS ====================
    case 'listCalls': {
      const response = await fubApi.get('/calls', { params: args });
      return { calls: response.data.calls, _metadata: response.data._metadata };
    }
    case 'createCall': {
      const body = translateCallArgs(args);
      const response = await fubApi.post('/calls', body);
      return response.data;
    }
    case 'getCall': {
      const response = await fubApi.get(`/calls/${args.id}`);
      return response.data;
    }
    case 'updateCall': {
      const { id, ...rest } = args;
      const body = translateCallArgs(rest);
      const response = await fubApi.put(`/calls/${id}`, body);
      return response.data;
    }

    // ==================== TEXT MESSAGES ====================
    case 'listTextMessages': {
      const response = await fubApi.get('/textMessages', { params: args });
      return { textMessages: response.data.textMessages || response.data.textmessages, _metadata: response.data._metadata };
    }
    case 'createTextMessage': {
      requireSystemCreds('createTextMessage');
      const response = await fubApi.post('/textMessages', args);
      return response.data;
    }
    case 'getTextMessage': {
      const response = await fubApi.get(`/textMessages/${args.id}`);
      return response.data;
    }

    // ==================== USERS ====================
    case 'listUsers': {
      const response = await fubApi.get('/users', { params: args });
      return { users: response.data.users, _metadata: response.data._metadata };
    }
    case 'getUser': {
      const response = await fubApi.get(`/users/${args.id}`);
      return response.data;
    }
    case 'deleteUser': {
      await fubApi.delete(`/users/${args.id}`);
      return { success: true, message: `User ${args.id} deleted` };
    }

    // ==================== SMART LISTS ====================
    case 'listSmartLists': {
      const response = await fubApi.get('/smartLists', { params: args });
      return { smartLists: response.data.smartLists || response.data.smartlists, _metadata: response.data._metadata };
    }
    case 'getSmartList': {
      const response = await fubApi.get(`/smartLists/${args.id}`);
      return response.data;
    }

    // ==================== ACTION PLANS ====================
    case 'listActionPlans': {
      const response = await fubApi.get('/actionPlans', { params: args });
      return { actionPlans: response.data.actionPlans || response.data.actionplans, _metadata: response.data._metadata };
    }
    case 'listActionPlansPeople': {
      const response = await fubApi.get('/actionPlansPeople', { params: args });
      return { actionPlansPeople: response.data.actionPlansPeople || response.data.actionplanspeople, _metadata: response.data._metadata };
    }
    case 'addPersonToActionPlan': {
      const response = await fubApi.post('/actionPlansPeople', args);
      return response.data;
    }
    case 'updateActionPlanPerson': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/actionPlansPeople/${id}`, body);
      return response.data;
    }

    // ==================== AUTOMATIONS ====================
    case 'listAutomations': {
      requireSystemCreds('listAutomations');
      const response = await fubApi.get('/automations', { params: args });
      return { automations: response.data.automations, _metadata: response.data._metadata };
    }
    case 'getAutomation': {
      requireSystemCreds('getAutomation');
      const response = await fubApi.get(`/automations/${args.id}`);
      return response.data;
    }
    case 'listAutomationsPeople': {
      requireSystemCreds('listAutomationsPeople');
      const response = await fubApi.get('/automationsPeople', { params: args });
      return { automationsPeople: response.data.automationsPeople || response.data.automationspeople, _metadata: response.data._metadata };
    }
    case 'getAutomationPerson': {
      requireSystemCreds('getAutomationPerson');
      const response = await fubApi.get(`/automationsPeople/${args.id}`);
      return response.data;
    }
    case 'addPersonToAutomation': {
      requireSystemCreds('addPersonToAutomation');
      const response = await fubApi.post('/automationsPeople', args);
      return response.data;
    }
    case 'updateAutomationPerson': {
      requireSystemCreds('updateAutomationPerson');
      const { id, ...body } = args;
      const response = await fubApi.put(`/automationsPeople/${id}`, body);
      return response.data;
    }

    // ==================== EMAIL TEMPLATES ====================
    case 'listTemplates': {
      const response = await fubApi.get('/templates', { params: args });
      return { templates: response.data.templates, _metadata: response.data._metadata };
    }
    case 'createTemplate': {
      const response = await fubApi.post('/templates', args);
      return response.data;
    }
    case 'getTemplate': {
      const response = await fubApi.get(`/templates/${args.id}`);
      return response.data;
    }
    case 'updateTemplate': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/templates/${id}`, body);
      return response.data;
    }
    case 'mergeTemplate': {
      const response = await fubApi.post('/templates/merge', args);
      return response.data;
    }
    case 'deleteTemplate': {
      await fubApi.delete(`/templates/${args.id}`);
      return { success: true, message: `Template ${args.id} deleted` };
    }

    // ==================== TEXT MESSAGE TEMPLATES ====================
    case 'listTextMessageTemplates': {
      const response = await fubApi.get('/textMessageTemplates', { params: args });
      return { textMessageTemplates: response.data.textMessageTemplates || response.data.textmessagetemplates, _metadata: response.data._metadata };
    }
    case 'createTextMessageTemplate': {
      const response = await fubApi.post('/textMessageTemplates', args);
      return response.data;
    }
    case 'getTextMessageTemplate': {
      const response = await fubApi.get(`/textMessageTemplates/${args.id}`);
      return response.data;
    }
    case 'updateTextMessageTemplate': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/textMessageTemplates/${id}`, body);
      return response.data;
    }
    case 'mergeTextMessageTemplate': {
      const response = await fubApi.post('/textMessageTemplates/merge', args);
      return response.data;
    }
    case 'deleteTextMessageTemplate': {
      await fubApi.delete(`/textMessageTemplates/${args.id}`);
      return { success: true, message: `Text message template ${args.id} deleted` };
    }

    // ==================== EMAIL MARKETING ====================
    case 'listEmEvents': {
      const response = await fubApi.get('/emEvents', { params: args });
      return { emEvents: response.data.emEvents || response.data.emevents, _metadata: response.data._metadata };
    }
    case 'createEmEvent': {
      const response = await fubApi.post('/emEvents', args);
      return response.data;
    }
    case 'listEmCampaigns': {
      const response = await fubApi.get('/emCampaigns', { params: args });
      return { emCampaigns: response.data.emCampaigns || response.data.emcampaigns, _metadata: response.data._metadata };
    }
    case 'createEmCampaign': {
      const response = await fubApi.post('/emCampaigns', args);
      return response.data;
    }
    case 'updateEmCampaign': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/emCampaigns/${id}`, body);
      return response.data;
    }

    // ==================== CUSTOM FIELDS ====================
    case 'listCustomFields': {
      const response = await fubApi.get('/customFields');
      return { customFields: response.data.customFields || response.data.customfields, _metadata: response.data._metadata };
    }
    case 'createCustomField': {
      const response = await fubApi.post('/customFields', args);
      return response.data;
    }
    case 'getCustomField': {
      const response = await fubApi.get(`/customFields/${args.id}`);
      return response.data;
    }
    case 'updateCustomField': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/customFields/${id}`, body);
      return response.data;
    }
    case 'deleteCustomField': {
      await fubApi.delete(`/customFields/${args.id}`);
      return { success: true, message: `Custom field ${args.id} deleted` };
    }

    // ==================== STAGES ====================
    case 'listStages': {
      const response = await fubApi.get('/stages');
      return { stages: response.data.stages, _metadata: response.data._metadata };
    }
    case 'createStage': {
      const response = await fubApi.post('/stages', args);
      return response.data;
    }
    case 'getStage': {
      const response = await fubApi.get(`/stages/${args.id}`);
      return response.data;
    }
    case 'updateStage': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/stages/${id}`, body);
      return response.data;
    }
    case 'deleteStage': {
      await fubApi.delete(`/stages/${args.id}`);
      return { success: true, message: `Stage ${args.id} deleted` };
    }

    // ==================== TASKS ====================
    case 'listTasks': {
      const response = await fubApi.get('/tasks', { params: args });
      return { tasks: response.data.tasks, _metadata: response.data._metadata };
    }
    case 'createTask': {
      const response = await fubApi.post('/tasks', args);
      return response.data;
    }
    case 'getTask': {
      const response = await fubApi.get(`/tasks/${args.id}`);
      return response.data;
    }
    case 'updateTask': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/tasks/${id}`, body);
      return response.data;
    }
    case 'deleteTask': {
      await fubApi.delete(`/tasks/${args.id}`);
      return { success: true, message: `Task ${args.id} deleted` };
    }

    // ==================== APPOINTMENTS ====================
    case 'listAppointments': {
      const response = await fubApi.get('/appointments', { params: args });
      return { appointments: response.data.appointments, _metadata: response.data._metadata };
    }
    case 'createAppointment': {
      const body = translateAppointmentArgs(args);
      const response = await fubApi.post('/appointments', body);
      return response.data;
    }
    case 'getAppointment': {
      const response = await fubApi.get(`/appointments/${args.id}`);
      return response.data;
    }
    case 'updateAppointment': {
      const { id, ...rest } = args;
      const body = translateAppointmentArgs(rest);
      const response = await fubApi.put(`/appointments/${id}`, body);
      return response.data;
    }
    case 'deleteAppointment': {
      await fubApi.delete(`/appointments/${args.id}`);
      return { success: true, message: `Appointment ${args.id} deleted` };
    }

    // ==================== APPOINTMENT TYPES ====================
    case 'listAppointmentTypes': {
      const response = await fubApi.get('/appointmentTypes');
      return { appointmentTypes: response.data.appointmentTypes || response.data.appointmenttypes, _metadata: response.data._metadata };
    }
    case 'createAppointmentType': {
      const response = await fubApi.post('/appointmentTypes', args);
      return response.data;
    }
    case 'getAppointmentType': {
      const response = await fubApi.get(`/appointmentTypes/${args.id}`);
      return response.data;
    }
    case 'updateAppointmentType': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/appointmentTypes/${id}`, body);
      return response.data;
    }
    case 'deleteAppointmentType': {
      await fubApi.delete(`/appointmentTypes/${args.id}`);
      return { success: true, message: `Appointment type ${args.id} deleted` };
    }

    // ==================== APPOINTMENT OUTCOMES ====================
    case 'listAppointmentOutcomes': {
      const response = await fubApi.get('/appointmentOutcomes');
      return { appointmentOutcomes: response.data.appointmentOutcomes || response.data.appointmentoutcomes, _metadata: response.data._metadata };
    }
    case 'createAppointmentOutcome': {
      const response = await fubApi.post('/appointmentOutcomes', args);
      return response.data;
    }
    case 'getAppointmentOutcome': {
      const response = await fubApi.get(`/appointmentOutcomes/${args.id}`);
      return response.data;
    }
    case 'updateAppointmentOutcome': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/appointmentOutcomes/${id}`, body);
      return response.data;
    }
    case 'deleteAppointmentOutcome': {
      await fubApi.delete(`/appointmentOutcomes/${args.id}`);
      return { success: true, message: `Appointment outcome ${args.id} deleted` };
    }

    // ==================== WEBHOOKS ====================
    case 'listWebhooks': {
      requireWebhookCreds();
      const response = await fubApi.get('/webhooks');
      return { webhooks: response.data.webhooks, _metadata: response.data._metadata };
    }
    case 'createWebhook': {
      requireWebhookCreds();
      const response = await fubApi.post('/webhooks', args);
      return response.data;
    }
    case 'getWebhook': {
      const response = await fubApi.get(`/webhooks/${args.id}`);
      return response.data;
    }
    case 'updateWebhook': {
      requireWebhookCreds();
      const { id, ...body } = args;
      const response = await fubApi.put(`/webhooks/${id}`, body);
      return response.data;
    }
    case 'deleteWebhook': {
      requireWebhookCreds();
      await fubApi.delete(`/webhooks/${args.id}`);
      return { success: true, message: `Webhook ${args.id} deleted` };
    }
    case 'getWebhookEvents': {
      const response = await fubApi.get(`/webhookEvents/${args.id}`);
      return response.data;
    }

    // ==================== PIPELINES ====================
    case 'listPipelines': {
      const response = await fubApi.get('/pipelines');
      return { pipelines: response.data.pipelines, _metadata: response.data._metadata };
    }
    case 'createPipeline': {
      const response = await fubApi.post('/pipelines', args);
      return response.data;
    }
    case 'getPipeline': {
      const response = await fubApi.get(`/pipelines/${args.id}`);
      return response.data;
    }
    case 'updatePipeline': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/pipelines/${id}`, body);
      return response.data;
    }
    case 'deletePipeline': {
      await fubApi.delete(`/pipelines/${args.id}`);
      return { success: true, message: `Pipeline ${args.id} deleted` };
    }

    // ==================== DEALS ====================
    case 'listDeals': {
      const response = await fubApi.get('/deals', { params: args });
      return { deals: response.data.deals, _metadata: response.data._metadata };
    }
    case 'createDeal': {
      const body = translateDealArgs(args);
      const response = await fubApi.post('/deals', body);
      return response.data;
    }
    case 'getDeal': {
      const response = await fubApi.get(`/deals/${args.id}`);
      return response.data;
    }
    case 'updateDeal': {
      const { id, ...rest } = args;
      const body = translateDealArgs(rest);
      const response = await fubApi.put(`/deals/${id}`, body);
      return response.data;
    }
    case 'deleteDeal': {
      await fubApi.delete(`/deals/${args.id}`);
      return { success: true, message: `Deal ${args.id} deleted` };
    }

    // ==================== DEAL ATTACHMENTS ====================
    case 'createDealAttachment': {
      requireSystemCreds('createDealAttachment');
      const response = await fubApi.post('/dealAttachments', args);
      return response.data;
    }
    case 'getDealAttachment': {
      const response = await fubApi.get(`/dealAttachments/${args.id}`);
      return response.data;
    }
    case 'updateDealAttachment': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/dealAttachments/${id}`, body);
      return response.data;
    }
    case 'deleteDealAttachment': {
      await fubApi.delete(`/dealAttachments/${args.id}`);
      return { success: true, message: `Deal attachment ${args.id} deleted` };
    }

    // ==================== DEAL CUSTOM FIELDS ====================
    case 'listDealCustomFields': {
      const response = await fubApi.get('/dealCustomFields');
      return { dealCustomFields: response.data.dealCustomFields || response.data.dealcustomfields, _metadata: response.data._metadata };
    }
    case 'createDealCustomField': {
      const body = translateDealCustomFieldArgs(args);
      const response = await fubApi.post('/dealCustomFields', body);
      return response.data;
    }
    case 'getDealCustomField': {
      const response = await fubApi.get(`/dealCustomFields/${args.id}`);
      return response.data;
    }
    case 'updateDealCustomField': {
      const { id, ...rest } = args;
      const body = translateDealCustomFieldArgs(rest);
      const response = await fubApi.put(`/dealCustomFields/${id}`, body);
      return response.data;
    }
    case 'deleteDealCustomField': {
      await fubApi.delete(`/dealCustomFields/${args.id}`);
      return { success: true, message: `Deal custom field ${args.id} deleted` };
    }

    // ==================== GROUPS ====================
    case 'listGroups': {
      const response = await fubApi.get('/groups');
      return { groups: response.data.groups, _metadata: response.data._metadata };
    }
    case 'listRoundRobinGroups': {
      const response = await fubApi.get('/groups/roundRobin');
      return { groups: response.data.groups, _metadata: response.data._metadata };
    }
    case 'createGroup': {
      const response = await fubApi.post('/groups', args);
      return response.data;
    }
    case 'getGroup': {
      const response = await fubApi.get(`/groups/${args.id}`);
      return response.data;
    }
    case 'updateGroup': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/groups/${id}`, body);
      return response.data;
    }
    case 'deleteGroup': {
      await fubApi.delete(`/groups/${args.id}`);
      return { success: true, message: `Group ${args.id} deleted` };
    }

    // ==================== TEAMS ====================
    case 'listTeams': {
      const response = await fubApi.get('/teams');
      return { teams: response.data.teams, _metadata: response.data._metadata };
    }
    case 'createTeam': {
      const response = await fubApi.post('/teams', args);
      return response.data;
    }
    case 'getTeam': {
      const response = await fubApi.get(`/teams/${args.id}`);
      return response.data;
    }
    case 'updateTeam': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/teams/${id}`, body);
      return response.data;
    }
    case 'deleteTeam': {
      await fubApi.delete(`/teams/${args.id}`);
      return { success: true, message: `Team ${args.id} deleted` };
    }

    // ==================== TEAM INBOXES ====================
    case 'listTeamInboxes': {
      const response = await fubApi.get('/teamInboxes');
      return { teamInboxes: response.data.teamInboxes || response.data.teaminboxes, _metadata: response.data._metadata };
    }

    // ==================== PONDS ====================
    case 'listPonds': {
      const response = await fubApi.get('/ponds');
      return { ponds: response.data.ponds, _metadata: response.data._metadata };
    }
    case 'createPond': {
      const response = await fubApi.post('/ponds', args);
      return response.data;
    }
    case 'getPond': {
      const response = await fubApi.get(`/ponds/${args.id}`);
      return response.data;
    }
    case 'updatePond': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/ponds/${id}`, body);
      return response.data;
    }
    case 'deletePond': {
      await fubApi.delete(`/ponds/${args.id}`);
      return { success: true, message: `Pond ${args.id} deleted` };
    }

    // ==================== TIMEFRAMES ====================
    case 'listTimeframes': {
      const response = await fubApi.get('/timeframes');
      return { timeframes: response.data.timeframes, _metadata: response.data._metadata };
    }

    // ==================== INBOX APPS ====================
    // FUB inbox app endpoints — corrected paths per docs.followupboss.com/reference.
    // Old "/inboxApps/addMessage" style was wrong (no such collection); FUB uses
    // /inboxApps/messages, /inboxApps/notes, /inboxApps/conversations/:id, etc.
    case 'inboxAppAddMessage': {
      const response = await fubApi.post('/inboxApps/messages', args);
      return response.data;
    }
    case 'inboxAppUpdateMessage': {
      const { messageId, id, ...body } = args;
      const mid = messageId || id;
      const response = await fubApi.put(`/inboxApps/messages/${mid}`, body);
      return response.data;
    }
    case 'inboxAppAddNote': {
      const response = await fubApi.post('/inboxApps/notes', args);
      return response.data;
    }
    case 'inboxAppUpdateConversation': {
      const { conversationId, id, ...body } = args;
      const cid = conversationId || id;
      const response = await fubApi.put(`/inboxApps/conversations/${cid}`, body);
      return response.data;
    }
    case 'inboxAppGetParticipants': {
      const response = await fubApi.get('/inboxApps/participants', { params: args });
      return response.data;
    }
    case 'inboxAppCreateParticipant': {
      const response = await fubApi.post('/inboxApps/participants', args);
      return response.data;
    }
    case 'inboxAppDeleteParticipant': {
      const { id, participantId } = args;
      const pid = id || participantId;
      await fubApi.delete(`/inboxApps/participants/${pid}`);
      return { success: true, message: `Participant ${pid} removed` };
    }
    case 'inboxAppInstall': {
      const response = await fubApi.post('/inboxApps/install', args);
      return response.data;
    }
    case 'inboxAppDeactivate': {
      // FUB deactivates by installation id, not a fixed /deactivate path.
      const { id } = args;
      if (!id) throw new Error('inboxAppDeactivate requires installation id');
      await fubApi.delete(`/inboxApps/${id}`);
      return { success: true, message: `Inbox app ${id} deactivated` };
    }
    case 'listInboxAppInstallations': {
      const response = await fubApi.get('/inboxApps');
      return response.data;
    }

    // ==================== REACTIONS ====================
    case 'getReactions': {
      const response = await fubApi.get(`/reactions/${args.id}`);
      return response.data;
    }
    case 'createReaction': {
      const { refType, refId, ...body } = args;
      const response = await fubApi.post(`/reactions/${refType}/${refId}`, body);
      return response.data;
    }
    case 'deleteReaction': {
      const { refType, refId } = args;
      await fubApi.delete(`/reactions/${refType}/${refId}`);
      return { success: true, message: 'Reaction deleted' };
    }

    // ==================== THREADED REPLIES ====================
    case 'getThreadedReplies': {
      const response = await fubApi.get(`/threadedReplies/${args.id}`);
      return response.data;
    }

    // ==================== CONVENIENCE TOOLS ====================
    case 'removeTagFromPerson': {
      const person = await fubApiWithRetry('get', `/people/${args.id}`);
      const currentTags = person.data.tags || [];
      const tagLower = args.tag.toLowerCase();
      const newTags = currentTags.filter(t => t.toLowerCase() !== tagLower);
      if (newTags.length === currentTags.length) {
        return { success: false, message: `Tag "${args.tag}" not found on person ${args.id}`, currentTags };
      }
      const response = await fubApiWithRetry('put', `/people/${args.id}`, { tags: newTags });
      return { success: true, message: `Tag "${args.tag}" removed`, removedTag: args.tag, remainingTags: newTags };
    }
    case 'getPersonByEmail': {
      const response = await fubApiWithRetry('get', '/people', { params: { email: args.email, limit: 1 } });
      const people = response.data.people || [];
      if (people.length === 0) {
        return { found: false, message: `No person found with email ${args.email}` };
      }
      return { found: true, person: people[0] };
    }
    case 'searchPeopleByTag': {
      const { tags, ...params } = args;
      const response = await fubApiWithRetry('get', '/people', { params: { tags, ...params } });
      return { people: response.data.people, _metadata: response.data._metadata };
    }
    case 'bulkUpdatePeople': {
      const { ids, updates, mergeTags } = args;
      const results = [];
      const batchSize = 20;
      for (let i = 0; i < ids.length; i++) {
        try {
          const params = mergeTags !== undefined ? { mergeTags } : {};
          const response = await fubApiWithRetry('put', `/people/${ids[i]}`, updates, { params });
          results.push({ id: ids[i], success: true });
        } catch (error) {
          results.push({ id: ids[i], success: false, error: error.response?.data?.errorMessage || error.message });
        }
        // Throttle: pause every 20 requests to stay under 25 PUTs/10sec
        if ((i + 1) % batchSize === 0 && i + 1 < ids.length) {
          await new Promise(r => setTimeout(r, 11000));
        }
      }
      const succeeded = results.filter(r => r.success).length;
      return { total: ids.length, succeeded, failed: ids.length - succeeded, results };
    }
    case 'listAvailableTags': {
      const scanLimit = Math.min(args.limit || 500, 500);
      const allTags = new Set();
      let offset = 0;
      const pageSize = 100;
      while (offset < scanLimit) {
        const response = await fubApiWithRetry('get', '/people', { params: { limit: pageSize, offset, fields: 'tags' } });
        const people = response.data.people || [];
        if (people.length === 0) break;
        for (const person of people) {
          if (person.tags) person.tags.forEach(t => allTags.add(t));
        }
        offset += pageSize;
      }
      const sorted = [...allTags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      return { count: sorted.length, tags: sorted, contactsScanned: offset };
    }

    default:
      return { error: `Unknown tool: ${name}` };
    }
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

export const activeTools = FUB_SAFE_MODE
  ? TOOL_DEFINITIONS.filter(t => !t.name.toLowerCase().startsWith('delete') && t.name !== 'inboxAppDeleteParticipant' && t.name !== 'deleteReaction')
  : TOOL_DEFINITIONS;

/**
 * Create an MCP Server with the FUB tool surface.
 *
 * @param {object} [opts]
 * @param {Array} [opts.extraTools] - Additional tool definitions to merge with the
 *   built-in TOOL_DEFINITIONS. Used by private deployments that layer custom tools
 *   (e.g., cookie-auth messaging) on top of the public API-key tool surface.
 * @param {Function} [opts.extraHandler] - async (name, args) => result. Called for
 *   any tool name not in the built-in handler. Throw to propagate as error.
 * @param {object} [opts.serverInfo] - Override name/version/description in the MCP
 *   server handshake. Useful for private deployments that want to identify themselves.
 */
export function createServer(opts = {}) {
  const { extraTools = [], extraHandler = null, serverInfo = {} } = opts;

  const server = new Server(
    {
      name: serverInfo.name || 'followupboss-mcp-server',
      version: serverInfo.version || '1.3.1',
      description: serverInfo.description || 'Follow Up Boss MCP server by Ed Neuhaus, real estate broker @ Neuhaus Realty Group (neuhausre.com). Call the `about` tool for more, or `help` for usage tips.'
    },
    { capabilities: { tools: {} } }
  );

  // Active built-in tools (filtered for SAFE MODE) + any caller-supplied extras.
  // Extras are NOT auto-filtered by SAFE MODE -- caller decides per-tool.
  const extendedTools = [...activeTools, ...extraTools];
  const extraToolNames = new Set(extraTools.map(t => t.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: extendedTools
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (FUB_SAFE_MODE && (name.toLowerCase().startsWith('delete') || name === 'inboxAppDeleteParticipant' || name === 'deleteReaction')) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'This tool is disabled in Safe Mode. To enable delete operations, set FUB_SAFE_MODE=false or remove it from your config.' }, null, 2) }],
        isError: true,
      };
    }
    try {
      let result;
      if (extraToolNames.has(name) && extraHandler) {
        result = await extraHandler(name, args || {});
      } else {
        result = await handleToolCall(name, args || {});
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const status = error.response?.status;
      const apiMsg = error.response?.data?.errorMessage
        || error.response?.data?.error?.errorMessage
        || error.message;
      const payload = { error: apiMsg, status };
      if (status === 403) {
        payload.hint = 'FUB returned 403 Forbidden. Common causes: (1) feature not enabled on your FUB plan, (2) your API key lacks scope for this resource, (3) action requires account owner permissions. Tools known to require elevated permissions: createTextMessage, listAutomations, createPersonAttachment, createDealAttachment, all webhook tools, and inbox app tools.';
      }
      if (error.response?.data) payload.details = error.response.data;
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Transports: stdio (default, for Claude Desktop) or HTTP (for remote
// deployments — set MCP_TRANSPORT=http). HTTP serves Claude.ai web/mobile
// connectors via Streamable HTTP + optional OAuth 2.1.
// ---------------------------------------------------------------------------

export async function startStdio(opts = {}) {
  const transport = new StdioServerTransport();
  const server = createServer(opts);
  await server.connect(transport);
  console.error(`Follow Up Boss MCP Server v1.3.1 started via stdio (${activeTools.length} tools${FUB_SAFE_MODE ? ', SAFE MODE — delete tools disabled' : ''})`);
  console.error(`Built by Ed Neuhaus, broker @ Neuhaus Realty Group, Austin TX — https://neuhausre.com`);
  console.error(`Call the 'about' tool for full bio. Call 'help' for usage tips.`);
}

export async function startHttp(opts = {}) {
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const BEARER = process.env.MCP_BEARER_TOKEN;
  const AUTH_PASSWORD = process.env.MCP_AUTH_PASSWORD;
  const AUTH_DISABLED = process.env.MCP_AUTH_DISABLED === 'true' || (!BEARER && !AUTH_PASSWORD);
  const OAUTH_ENABLED = !!AUTH_PASSWORD && !AUTH_DISABLED;
  const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  if (AUTH_DISABLED) {
    console.error('WARNING: HTTP transport running without auth. Anyone who knows the URL can call the MCP.');
  } else if (OAUTH_ENABLED) {
    console.error('HTTP transport running with OAuth 2.1 (DCR + PKCE + password gate).');
  } else {
    console.error('HTTP transport running with static bearer token.');
  }

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));

  // In-memory OAuth state. Server restart invalidates everything (re-auth required).
  const clients = new Map();       // client_id -> { client_secret, redirect_uris, created_at }
  const authCodes = new Map();     // code       -> { client_id, redirect_uri, code_challenge, expires_at }
  const accessTokens = new Map();  // token      -> { client_id, expires_at }

  // Periodic cleanup of expired state.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of authCodes) if (v.expires_at < now) authCodes.delete(k);
    for (const [k, v] of accessTokens) if (v.expires_at < now) accessTokens.delete(k);
  }, 60 * 1000);

  function baseUrl(req) {
    // Reverse proxies (Traefik, Cloudflare, Railway) terminate TLS at the edge;
    // x-forwarded-proto carries the real scheme.
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    return `${proto}://${req.get('host')}`;
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function constantTimeEq(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  // Health endpoint (no auth)
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: '1.3.3',
      tools: activeTools.length,
      safeMode: FUB_SAFE_MODE,
      authMode: AUTH_DISABLED ? 'none' : (OAUTH_ENABLED ? 'oauth2.1' : 'bearer'),
      ts: new Date().toISOString()
    });
  });

  // OAuth 2.1 metadata (RFC 8414). Claude's custom connector reads this to
  // discover the authorize / token / register endpoints.
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp']
    });
  });

  // MCP resource metadata (RFC 9728) — lets clients discover the AS for this resource.
  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const base = baseUrl(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ['mcp']
    });
  });

  // OAuth: Dynamic Client Registration (RFC 7591). Claude registers itself
  // dynamically; we hand back a client_id with no secret (public client).
  app.post('/oauth/register', (req, res) => {
    if (!OAUTH_ENABLED) return res.status(404).json({ error: 'oauth_disabled' });
    const redirect_uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    if (!redirect_uris.length) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
    }
    const client_id = randomBytes(16).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    clients.set(client_id, { redirect_uris, created_at: now });
    res.status(201).json({
      client_id,
      client_id_issued_at: now,
      redirect_uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp'
    });
  });

  // OAuth: Authorization endpoint. GET renders a password form. POST checks
  // the password, mints an auth code, redirects back to the client.
  app.get('/oauth/authorize', (req, res) => {
    if (!OAUTH_ENABLED) return res.status(404).send('OAuth disabled');
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
    const client = clients.get(client_id);
    if (!client) return res.status(400).send('Invalid client_id');
    if (!client.redirect_uris.includes(redirect_uri)) return res.status(400).send('redirect_uri not registered');
    if (response_type !== 'code') return res.status(400).send('Only response_type=code supported');
    if (code_challenge_method !== 'S256') return res.status(400).send('Only S256 PKCE supported');
    if (!code_challenge) return res.status(400).send('code_challenge required');

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Follow Up Boss MCP Authorization</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Arial,sans-serif;background:#0e0e0e;color:#eee;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:28px 32px;width:360px;max-width:90%}
  h1{font-size:18px;margin:0 0 6px;letter-spacing:-0.01em}
  p{color:#aaa;font-size:13px;margin:0 0 20px;line-height:1.45}
  label{display:block;font-size:12px;color:#aaa;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em}
  input[type=password]{width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#eee;padding:10px 12px;border-radius:6px;font-size:14px;margin-bottom:18px}
  input[type=password]:focus{outline:none;border-color:#6aa3ff}
  button{width:100%;background:#6aa3ff;color:#0a0a0a;border:0;padding:10px;font-size:14px;font-weight:600;border-radius:6px;cursor:pointer}
  button:hover{background:#8bb8ff}
  .err{background:#3a1a1a;color:#ff9999;padding:8px 10px;border-radius:4px;font-size:13px;margin-bottom:14px}
  .meta{margin-top:16px;font-size:11px;color:#666}
</style></head>
<body>
  <form class="card" method="POST" action="/oauth/authorize">
    <h1>Follow Up Boss MCP</h1>
    <p>Sign in to authorize <strong>${esc(client_id).slice(0,8)}…</strong> to access your FUB CRM tools.</p>
    ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
    <input type="hidden" name="client_id" value="${esc(client_id)}">
    <input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}">
    <input type="hidden" name="state" value="${esc(state || '')}">
    <input type="hidden" name="code_challenge" value="${esc(code_challenge)}">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Authorize</button>
    <div class="meta">This server runs in SAFE MODE${FUB_SAFE_MODE ? '' : ' (disabled)'} — delete operations are blocked.</div>
  </form>
</body></html>`);
  });

  app.post('/oauth/authorize', (req, res) => {
    if (!OAUTH_ENABLED) return res.status(404).send('OAuth disabled');
    const { client_id, redirect_uri, state, code_challenge, password } = req.body;
    const client = clients.get(client_id);
    if (!client) return res.status(400).send('Invalid client_id');
    if (!client.redirect_uris.includes(redirect_uri)) return res.status(400).send('redirect_uri not registered');

    if (!password || !constantTimeEq(password, AUTH_PASSWORD)) {
      const q = new URLSearchParams({
        client_id, redirect_uri, state: state || '', code_challenge,
        code_challenge_method: 'S256', response_type: 'code',
        err: 'Wrong password.'
      });
      return res.redirect(`/oauth/authorize?${q.toString()}`);
    }

    const code = randomBytes(32).toString('hex');
    authCodes.set(code, {
      client_id, redirect_uri, code_challenge,
      expires_at: Date.now() + AUTH_CODE_TTL_MS
    });
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  // OAuth: Token endpoint. Exchange authorization_code + PKCE verifier for an access token.
  app.post('/oauth/token', (req, res) => {
    if (!OAUTH_ENABLED) return res.status(404).json({ error: 'oauth_disabled' });
    const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;
    if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    const entry = authCodes.get(code);
    if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown code' });
    if (entry.expires_at < Date.now()) {
      authCodes.delete(code);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
    }
    if (entry.client_id !== client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    if (entry.redirect_uri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    if (!code_verifier) return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier required' });

    const expectedChallenge = createHash('sha256').update(code_verifier).digest('base64url');
    if (expectedChallenge !== entry.code_challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    authCodes.delete(code);
    const access_token = randomBytes(32).toString('hex');
    accessTokens.set(access_token, {
      client_id,
      expires_at: Date.now() + ACCESS_TOKEN_TTL_MS
    });
    res.json({
      access_token,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: 'mcp'
    });
  });

  // Auth middleware protecting /mcp.
  const wwwAuthenticateHeader = (req) => {
    const base = baseUrl(req);
    return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
  };

  const requireAuth = (req, res, next) => {
    if (AUTH_DISABLED) return next();
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) {
      res.set('WWW-Authenticate', wwwAuthenticateHeader(req));
      return res.status(401).json({ error: 'unauthorized' });
    }
    const token = header.slice(7).trim();
    if (OAUTH_ENABLED) {
      const entry = accessTokens.get(token);
      if (!entry || entry.expires_at < Date.now()) {
        res.set('WWW-Authenticate', wwwAuthenticateHeader(req));
        return res.status(401).json({ error: 'unauthorized' });
      }
      return next();
    }
    // Static bearer fallback (single-tenant deployments).
    if (!constantTimeEq(token, BEARER)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };

  // Stateful transport: each session gets its own transport + server instance.
  // The SDK's Server can only be connected to one transport at a time.
  const transports = new Map(); // sessionId -> transport

  app.post('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      const mcpServer = createServer(opts);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport)
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await mcpServer.connect(transport);
    }
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP POST error', e);
      if (!res.headersSent) res.status(500).json({ error: 'transport_error' });
    }
  });

  app.get('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) return res.status(400).json({ error: 'invalid_session' });
    try {
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error('MCP GET error', e);
    }
  });

  app.delete('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) return res.status(400).json({ error: 'invalid_session' });
    try {
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error('MCP DELETE error', e);
    }
  });

  app.listen(PORT, () => {
    console.error(`Follow Up Boss MCP Server v1.3.1 listening on :${PORT} (HTTP, ${activeTools.length} tools${FUB_SAFE_MODE ? ', SAFE MODE' : ''})`);
  });
}

async function main() {
  if (process.env.MCP_TRANSPORT === 'http') {
    await startHttp();
  } else {
    await startStdio();
  }
}

// Only auto-run if invoked directly (not when imported as a module).
// Allows private deployments to `import { createServer, startHttp } from
// 'followupboss-mcp-server'` and call them with custom overlays.
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
