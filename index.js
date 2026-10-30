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
 * Real estate referral in any state? https://neuhausre.com/contact/
 */

import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import axios from 'axios';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Load .env file if present (for standalone testing)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version;
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

// Safe Mode is ON unless explicitly disabled. An unset or unrecognized value
// means SAFE (delete tools blocked) so that a hand-configured install can never
// silently expose delete tools. Opt into Full Access with FUB_SAFE_MODE=false.
export const FUB_SAFE_MODE = process.env.FUB_SAFE_MODE !== 'false';
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
  // recordingUrl dropped: FUB masks the field on read for every integration, so writing it is a no-op.
  const { direction, notes, occurredAt, recordingUrl, ...rest } = args;
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

// FUB returns "* Recording URL is hidden for privacy reasons *" for ALL integrations —
// they confirmed recording URLs will never be exposed via the API. Replace the mystery
// string with one that answers the question so users stop asking (issue #2).
const RECORDING_URL_NOTE = 'Not available: Follow Up Boss does not expose call recording URLs through its API to any integration (confirmed by FUB support). See README.';
function redactRecordingUrl(call) {
  if (call && call.recordingUrl) call.recordingUrl = RECORDING_URL_NOTE;
  return call;
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

// FUB wants invitees as {userId:int} / {personId:int}.
// The old {type:"user"|"person", id} shape is accepted by FUB (200) but silently ignored, so
// invitees came back empty. Convert legacy shapes; pass the FUB shape through untouched.
function normalizeInvitees(list) {
  return list.map((inv) => {
    if (!inv || typeof inv !== 'object') return inv;
    if (inv.userId !== undefined || inv.personId !== undefined) return inv;
    if (inv.id !== undefined && (inv.type === 'user' || inv.type === 'person')) {
      const { type, id, ...rest } = inv;
      return type === 'user' ? { userId: Number(id), ...rest } : { personId: Number(id), ...rest };
    }
    return inv;
  });
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
    list.push({ personId: Number(personId) });
    out.invitees = list;
  }
  if (Array.isArray(out.invitees)) out.invitees = normalizeInvitees(out.invitees);
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

const TOOL_ERROR = Symbol('toolError');

function redactErrorDetails(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    let redacted = value;
    for (const secret of [FUB_API_KEY, FUB_SYSTEM_KEY]) {
      if (secret) redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactErrorDetails(item, seen));

  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(authorization|api[-_]?key|password|token|secret|system[-_]?key)/i.test(key)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redactErrorDetails(item, seen);
    }
  }
  return redacted;
}

function markToolError(payload) {
  Object.defineProperty(payload, TOOL_ERROR, { value: true });
  return payload;
}

function isToolError(result) {
  return Boolean(result?.[TOOL_ERROR]);
}

function handleApiError(error) {
  if (error.response) {
    const payload = {
      error: error.response.data?.errorMessage || error.response.data?.error?.errorMessage || error.message,
      status: error.response.status,
      details: error.response.data
    };
    if (error.response.status === 403) {
      payload.hint = 'FUB returned 403 Forbidden. Common causes: (1) feature not enabled on your FUB plan, (2) your API key lacks scope for this resource, (3) action requires account owner permissions. Tools known to require elevated permissions: createTextMessage, listAutomations, createPersonAttachment, createDealAttachment, all webhook tools, and inbox app tools.';
    }
    return markToolError(redactErrorDetails(payload));
  }
  return markToolError(redactErrorDetails({ error: error.message }));
}

// ---------------------------------------------------------------------------
// Tool Definitions (160 tools — 152 core + 5 convenience + 2 meta)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [

// ==================== EVENTS ====================
{
  "name": "listEvents",
  "description": "List events, newest first by FUB default. Filter by person, event type, or property.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "personId": {
        "type": "integer",
        "description": "Only events for this person."
      },
      "type": {
        "type": "string",
        "description": "Comma-separated types, e.g. 'Registration,Property Inquiry'. Full list = createEvent type enum."
      },
      "hasProperty": {
        "type": "boolean",
        "description": "true = only events with an associated property."
      },
      "propertyAddress": {
        "type": "string",
        "description": "Partial-match search of property addresses."
      }
    },
    "required": []
  }
},
{
  "name": "createEvent",
  "description": "Create an event (lead registration, inquiry, page view). Dedupes the person by phone/email and creates them if new. Events older than 1 day count as historical and fire no workflows. 'Inquiry' becomes Property Inquiry if property is set, else General Inquiry.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "source": {
        "type": "string",
        "description": "Lead source name."
      },
      "system": {
        "type": "string",
        "description": "Name of the system providing the lead."
      },
      "type": {
        "type": "string",
        "description": "Event type.",
        "enum": [
          "Registration",
          "Inquiry",
          "Seller Inquiry",
          "Property Inquiry",
          "General Inquiry",
          "Viewed Property",
          "Saved Property",
          "Visited Website",
          "Incoming Call",
          "Unsubscribed",
          "Property Search",
          "Saved Property Search",
          "Visited Open House",
          "Viewed Page"
        ]
      },
      "message": {
        "type": "string",
        "description": "Message from the lead about the inquiry."
      },
      "description": {
        "type": "string",
        "description": "Additional info about the inquiry."
      },
      "occurredAt": {
        "type": "string",
        "description": "When it occurred (ISO 8601). Docs type it as date."
      },
      "person": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "description": "Existing person ID; 404 if not found."
          },
          "firstName": {
            "type": "string",
            "description": "First name"
          },
          "lastName": {
            "type": "string",
            "description": "Last name"
          },
          "stage": {
            "type": "string",
            "description": "Stage name, e.g. Lead"
          },
          "source": {
            "type": "string",
            "description": "Lead source"
          },
          "sourceUrl": {
            "type": "string",
            "description": "Link to record at lead provider"
          },
          "contacted": {
            "type": "boolean",
            "description": "Default false"
          },
          "price": {
            "type": "integer",
            "description": "Estimated price"
          },
          "assignedTo": {
            "type": "string",
            "description": "Agent full name"
          },
          "assignedUserId": {
            "type": "integer",
            "description": "Agent user ID"
          },
          "assignedLenderName": {
            "type": "string",
            "description": "Lender full name"
          },
          "assignedLenderId": {
            "type": "integer",
            "description": "Lender user ID"
          },
          "emails": {
            "type": "array",
            "description": "Emails. First entry becomes primary. Each needs value.",
            "items": {
              "type": "object",
              "properties": {
                "value": {
                  "type": "string",
                  "description": "Email address"
                },
                "type": {
                  "type": "string",
                  "description": "e.g. work, home"
                },
                "isPrimary": {
                  "type": "boolean",
                  "description": "Not needed; first entry is primary"
                }
              },
              "required": [
                "value"
              ]
            }
          },
          "phones": {
            "type": "array",
            "description": "Phones. First entry becomes primary. Each needs value.",
            "items": {
              "type": "object",
              "properties": {
                "value": {
                  "type": "string",
                  "description": "Phone number, e.g. 888-555-1234"
                },
                "type": {
                  "type": "string",
                  "description": "e.g. mobile, home, fax"
                },
                "isPrimary": {
                  "type": "boolean",
                  "description": "Not needed; first entry is primary"
                }
              },
              "required": [
                "value"
              ]
            }
          },
          "addresses": {
            "type": "array",
            "description": "Contact addresses (not property addresses).",
            "items": {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "description": "home (default), work, mailing, investment"
                },
                "street": {
                  "type": "string",
                  "description": "Street"
                },
                "city": {
                  "type": "string",
                  "description": "City"
                },
                "state": {
                  "type": "string",
                  "description": "2-letter state code"
                },
                "code": {
                  "type": "string",
                  "description": "ZIP code as string"
                },
                "country": {
                  "type": "string",
                  "description": "Country name"
                }
              },
              "required": []
            }
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Tags to apply"
          }
        },
        "required": [],
        "additionalProperties": true
      },
      "property": {
        "type": "object",
        "properties": {
          "street": {
            "type": "string",
            "description": "Street"
          },
          "city": {
            "type": "string",
            "description": "City"
          },
          "state": {
            "type": "string",
            "description": "State code"
          },
          "code": {
            "type": "string",
            "description": "ZIP"
          },
          "mlsNumber": {
            "type": "string",
            "description": "MLS number"
          },
          "price": {
            "type": "integer",
            "description": "Asking price"
          },
          "forRent": {
            "type": "boolean",
            "description": "true if for rent"
          },
          "url": {
            "type": "string",
            "description": "Listing URL"
          },
          "type": {
            "type": "string",
            "description": "Freeform type, e.g. Bungalow"
          },
          "bedrooms": {
            "type": "string",
            "description": "Bedrooms"
          },
          "bathrooms": {
            "type": "string",
            "description": "Bathrooms"
          },
          "area": {
            "type": "string",
            "description": "Square feet"
          },
          "lot": {
            "type": "string",
            "description": "Acres"
          }
        },
        "required": []
      },
      "propertySearch": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "description": "e.g. Residential, Lot"
          },
          "neighborhood": {
            "type": "string",
            "description": "Neighborhood"
          },
          "city": {
            "type": "string",
            "description": "City"
          },
          "state": {
            "type": "string",
            "description": "State"
          },
          "code": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "ZIP codes"
          },
          "minPrice": {
            "type": "integer",
            "description": "Min price"
          },
          "maxPrice": {
            "type": "integer",
            "description": "Max price"
          },
          "minBedrooms": {
            "type": "integer",
            "description": "Min beds"
          },
          "maxBedrooms": {
            "type": "integer",
            "description": "Max beds"
          },
          "minBathrooms": {
            "type": "number",
            "description": "Min baths"
          },
          "maxBathrooms": {
            "type": "number",
            "description": "Max baths"
          }
        },
        "required": []
      },
      "campaign": {
        "type": "object",
        "properties": {
          "source": {
            "type": "string",
            "description": "Campaign source, e.g. Google"
          },
          "medium": {
            "type": "string",
            "description": "e.g. organic"
          },
          "term": {
            "type": "string",
            "description": "Search terms"
          },
          "content": {
            "type": "string",
            "description": "Content"
          },
          "campaign": {
            "type": "string",
            "description": "Campaign name"
          }
        },
        "required": [
          "source"
        ]
      },
      "pageTitle": {
        "type": "string",
        "description": "Page title (Viewed Page)."
      },
      "pageUrl": {
        "type": "string",
        "description": "Page URL (Viewed Page)."
      },
      "pageReferrer": {
        "type": "string",
        "description": "Referrer URL; also set pageUrl."
      },
      "pageDuration": {
        "type": "integer",
        "description": "Seconds on page."
      }
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
  "description": "List/search people, newest created first by default. Custom-field filters: pass any custom* key (e.g. customClosingDate); dates: ',2026-01-01' = on or before, '2026-01-01' = on or after, 'a,b' = inclusive. Filter by name, email, phone, stage name, tags (ANY), owner, price, smart list.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "Comma-separated person IDs."
      },
      "sort": {
        "type": "string",
        "description": "Default -created (newest first). '-' = descending. e.g. id, updated, name, price, stage, lastActivity, nextTask, customX."
      },
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "fields": {
        "type": "string",
        "description": "Comma-separated fields; allFields = everything, allCustom = all custom fields. id always included."
      },
      "lastActivityAfter": {
        "type": "string",
        "description": "Last activity after this time, e.g. 2016-11-23 01:02:03."
      },
      "lastActivityBefore": {
        "type": "string",
        "description": "Last activity before this time, e.g. 2016-11-23 01:02:03."
      },
      "name": {
        "type": "string",
        "description": "Partial name match."
      },
      "firstName": {
        "type": "string",
        "description": "Partial first-name match."
      },
      "lastName": {
        "type": "string",
        "description": "Partial last-name match."
      },
      "email": {
        "type": "string",
        "description": "Email address."
      },
      "phone": {
        "type": "string",
        "description": "Phone number."
      },
      "stage": {
        "type": "string",
        "description": "Stage NAME, not ID (e.g. Lead, Trash). Use listStages."
      },
      "source": {
        "type": "string",
        "description": "Lead source text."
      },
      "assignedTo": {
        "type": "string",
        "description": "Assigned user's name."
      },
      "assignedUserId": {
        "type": "integer",
        "description": "Assigned user ID."
      },
      "assignedPondId": {
        "type": "integer",
        "description": "Assigned pond ID."
      },
      "assignedLenderName": {
        "type": "string",
        "description": "Assigned lender name."
      },
      "assignedLenderId": {
        "type": "integer",
        "description": "Assigned lender user ID."
      },
      "contacted": {
        "type": "boolean",
        "description": "Filter by contacted."
      },
      "priceAbove": {
        "type": "integer",
        "description": "Price above this."
      },
      "priceBelow": {
        "type": "integer",
        "description": "Price below this."
      },
      "smartListId": {
        "type": "integer",
        "description": "People in this smart list."
      },
      "includeTrash": {
        "type": "boolean",
        "description": "Include Trash stage. Default false."
      },
      "includeUnclaimed": {
        "type": "boolean",
        "description": "Include unclaimed leads offered to current user. Default false."
      },
      "tags": {
        "type": "string",
        "description": "Comma-separated tags; matches people with ANY."
      }
    },
    "required": [],
    "additionalProperties": true
  }
},
{
  "name": "createPerson",
  "description": "Create a person. Custom fields: add top-level keys prefixed 'custom' (e.g. customClosingDate; see listCustomFields). Set deduplicate=true to avoid duplicates. source and sourceUrl can only be set here, not on update.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "firstName": {
        "type": "string",
        "description": "First name."
      },
      "lastName": {
        "type": "string",
        "description": "Last name."
      },
      "stage": {
        "type": "string",
        "description": "Stage name. Default Lead on create."
      },
      "contacted": {
        "type": "boolean",
        "description": "true also pauses action plans."
      },
      "price": {
        "type": "integer",
        "description": "Price point."
      },
      "assignedTo": {
        "type": "string",
        "description": "Assigned agent full name."
      },
      "assignedUserId": {
        "type": "integer",
        "description": "Assigned user ID."
      },
      "assignedPondId": {
        "type": "integer",
        "description": "Assigned pond ID."
      },
      "assignedLenderName": {
        "type": "string",
        "description": "Lender full name."
      },
      "assignedLenderId": {
        "type": "integer",
        "description": "Lender user ID."
      },
      "emails": {
        "type": "array",
        "description": "Emails. First entry becomes primary. Each needs value.",
        "items": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string",
              "description": "Email address"
            },
            "type": {
              "type": "string",
              "description": "e.g. work, home"
            },
            "isPrimary": {
              "type": "boolean",
              "description": "Not needed; first entry is primary"
            }
          },
          "required": [
            "value"
          ]
        }
      },
      "phones": {
        "type": "array",
        "description": "Phones. First entry becomes primary. Each needs value.",
        "items": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string",
              "description": "Phone number, e.g. 888-555-1234"
            },
            "type": {
              "type": "string",
              "description": "e.g. mobile, home, fax"
            },
            "isPrimary": {
              "type": "boolean",
              "description": "Not needed; first entry is primary"
            }
          },
          "required": [
            "value"
          ]
        }
      },
      "addresses": {
        "type": "array",
        "description": "Contact addresses (not property addresses).",
        "items": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "description": "home (default), work, mailing, investment"
            },
            "street": {
              "type": "string",
              "description": "Street"
            },
            "city": {
              "type": "string",
              "description": "City"
            },
            "state": {
              "type": "string",
              "description": "2-letter state code"
            },
            "code": {
              "type": "string",
              "description": "ZIP code as string"
            },
            "country": {
              "type": "string",
              "description": "Country name"
            }
          },
          "required": []
        }
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Tags."
      },
      "background": {
        "type": "string",
        "description": "Background info; multi-line OK."
      },
      "collaborators": {
        "type": "array",
        "items": {
          "type": "integer"
        },
        "description": "Collaborator user IDs; omitted IDs are removed."
      },
      "timeframeId": {
        "type": "integer",
        "description": "Timeframe ID (see listTimeframes)."
      },
      "deduplicate": {
        "type": "boolean",
        "description": "true = if email/phone matches, return that person unchanged (200). Default false."
      },
      "createdAt": {
        "type": "string",
        "description": "Creation time, for importing historical leads."
      },
      "source": {
        "type": "string",
        "description": "Lead source. Can only be set at creation."
      },
      "sourceUrl": {
        "type": "string",
        "description": "Link to record at lead provider. Creation only."
      }
    },
    "required": [],
    "additionalProperties": true
  }
},
{
  "name": "getPerson",
  "description": "Get one person by ID. Pass fields=allFields or allCustom to include custom fields.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Person ID."
      },
      "fields": {
        "type": "string",
        "description": "Comma-separated fields; allFields = everything, allCustom = all custom fields."
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "updatePerson",
  "description": "Update a person. tags replaces all tags unless mergeTags=true; phones replaces all numbers. Custom fields: top-level 'custom*' keys; JSON null clears one. source/sourceUrl cannot be changed.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "firstName": {
        "type": "string",
        "description": "First name."
      },
      "lastName": {
        "type": "string",
        "description": "Last name."
      },
      "stage": {
        "type": "string",
        "description": "Stage name. Default Lead on create."
      },
      "contacted": {
        "type": "boolean",
        "description": "true also pauses action plans."
      },
      "price": {
        "type": "integer",
        "description": "Price point."
      },
      "assignedTo": {
        "type": "string",
        "description": "Assigned agent full name."
      },
      "assignedUserId": {
        "type": "integer",
        "description": "Assigned user ID."
      },
      "assignedPondId": {
        "type": "integer",
        "description": "Assigned pond ID."
      },
      "assignedLenderName": {
        "type": "string",
        "description": "Lender full name."
      },
      "assignedLenderId": {
        "type": "integer",
        "description": "Lender user ID."
      },
      "emails": {
        "type": "array",
        "description": "Emails. First entry becomes primary. Each needs value.",
        "items": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string",
              "description": "Email address"
            },
            "type": {
              "type": "string",
              "description": "e.g. work, home"
            },
            "isPrimary": {
              "type": "boolean",
              "description": "Not needed; first entry is primary"
            }
          },
          "required": [
            "value"
          ]
        }
      },
      "phones": {
        "type": "array",
        "description": "Phones. REPLACES all existing numbers (incl. relationship ones); resend ones to keep.",
        "items": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string",
              "description": "Phone number, e.g. 888-555-1234"
            },
            "type": {
              "type": "string",
              "description": "e.g. mobile, home, fax"
            },
            "isPrimary": {
              "type": "boolean",
              "description": "Not needed; first entry is primary"
            }
          },
          "required": [
            "value"
          ]
        }
      },
      "addresses": {
        "type": "array",
        "description": "Contact addresses (not property addresses).",
        "items": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "description": "home (default), work, mailing, investment"
            },
            "street": {
              "type": "string",
              "description": "Street"
            },
            "city": {
              "type": "string",
              "description": "City"
            },
            "state": {
              "type": "string",
              "description": "2-letter state code"
            },
            "code": {
              "type": "string",
              "description": "ZIP code as string"
            },
            "country": {
              "type": "string",
              "description": "Country name"
            }
          },
          "required": []
        }
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Tags."
      },
      "background": {
        "type": "string",
        "description": "Background info; multi-line OK."
      },
      "timeframeId": {
        "type": "integer",
        "description": "Timeframe ID (see listTimeframes)."
      },
      "collaborators": {
        "type": "array",
        "items": {
          "type": "integer"
        },
        "description": "Collaborator user IDs; omitted IDs are removed."
      },
      "id": {
        "type": "integer",
        "description": "Person ID to update."
      },
      "mergeTags": {
        "type": "boolean",
        "description": "true = add tags to existing; otherwise tags REPLACES all tags."
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": true
  }
},
{
  "name": "deletePerson",
  "description": "Delete a person by ID. Docs do not say whether this is a soft or permanent delete.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Person ID."
      }
    },
    "required": [
      "id"
    ]
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
  "description": "Update a person attachment (externally hosted file). Needs registered-system credentials (X-System headers).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Attachment ID."
      },
      "personId": {
        "type": "integer",
        "description": "Person ID."
      },
      "uri": {
        "type": "string",
        "description": "Link to externally hosted file."
      },
      "fileName": {
        "type": "string",
        "description": "File name."
      },
      "fileSize": {
        "type": "integer",
        "description": "Size in bytes."
      }
    },
    "required": [
      "id",
      "personId",
      "uri",
      "fileName"
    ]
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
  "description": "List relationship contacts (spouse, partner, etc.), optionally for one person or by name.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "sort": {
        "type": "string",
        "description": "Sort field.",
        "enum": [
          "id",
          "created",
          "updated",
          "name",
          "firstName",
          "lastName",
          "personId"
        ]
      },
      "personId": {
        "type": "integer",
        "description": "Only relationships of this person."
      },
      "name": {
        "type": "string",
        "description": "Fuzzy name match."
      },
      "firstName": {
        "type": "string",
        "description": "Fuzzy first-name match."
      },
      "lastName": {
        "type": "string",
        "description": "Fuzzy last-name match."
      }
    },
    "required": []
  }
},
{
  "name": "createRelationship",
  "description": "Create a relationship contact (own record, e.g. Spouse) linked to a person. It is not a link between two existing people.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": {
        "type": "integer",
        "description": "Person this relationship belongs to."
      },
      "firstName": {
        "type": "string",
        "description": "First name."
      },
      "lastName": {
        "type": "string",
        "description": "Last name."
      },
      "type": {
        "type": "string",
        "description": "Relationship type, e.g. Spouse, Brother, Partner."
      },
      "emails": {
        "type": "array",
        "description": "Emails. First entry becomes primary. Each needs value.",
        "items": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string",
              "description": "Email address"
            },
            "type": {
              "type": "string",
              "description": "e.g. work, home"
            },
            "isPrimary": {
              "type": "boolean",
              "description": "Not needed; first entry is primary"
            }
          },
          "required": [
            "value"
          ]
        }
      },
      "phones": {
        "type": "array",
        "description": "Phones. First entry becomes primary. Each needs value.",
        "items": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string",
              "description": "Phone number, e.g. 888-555-1234"
            },
            "type": {
              "type": "string",
              "description": "e.g. mobile, home, fax"
            },
            "isPrimary": {
              "type": "boolean",
              "description": "Not needed; first entry is primary"
            }
          },
          "required": [
            "value"
          ]
        }
      },
      "addresses": {
        "type": "array",
        "description": "Contact addresses (not property addresses).",
        "items": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "description": "home (default), work, mailing, investment"
            },
            "street": {
              "type": "string",
              "description": "Street"
            },
            "city": {
              "type": "string",
              "description": "City"
            },
            "state": {
              "type": "string",
              "description": "2-letter state code"
            },
            "code": {
              "type": "string",
              "description": "ZIP code as string"
            },
            "country": {
              "type": "string",
              "description": "Country name"
            }
          },
          "required": []
        }
      }
    },
    "required": []
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
  "description": "Update a relationship contact. emails/phones/addresses arrays OVERWRITE existing values (empty array = unchanged). personId cannot be changed.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Relationship ID."
      },
      "firstName": {
        "type": "string",
        "description": "First name."
      },
      "lastName": {
        "type": "string",
        "description": "Last name."
      },
      "type": {
        "type": "string",
        "description": "Relationship type, e.g. Spouse."
      },
      "emails": {
        "type": "array",
        "description": "Emails. First entry becomes primary. Each needs value.",
        "items": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string",
              "description": "Email address"
            },
            "type": {
              "type": "string",
              "description": "e.g. work, home"
            },
            "isPrimary": {
              "type": "boolean",
              "description": "Not needed; first entry is primary"
            }
          },
          "required": [
            "value"
          ]
        }
      },
      "phones": {
        "type": "array",
        "description": "Phones. First entry becomes primary. Each needs value.",
        "items": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string",
              "description": "Phone number, e.g. 888-555-1234"
            },
            "type": {
              "type": "string",
              "description": "e.g. mobile, home, fax"
            },
            "isPrimary": {
              "type": "boolean",
              "description": "Not needed; first entry is primary"
            }
          },
          "required": [
            "value"
          ]
        }
      },
      "addresses": {
        "type": "array",
        "description": "Contact addresses (not property addresses).",
        "items": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "description": "home (default), work, mailing, investment"
            },
            "street": {
              "type": "string",
              "description": "Street"
            },
            "city": {
              "type": "string",
              "description": "City"
            },
            "state": {
              "type": "string",
              "description": "2-letter state code"
            },
            "code": {
              "type": "string",
              "description": "ZIP code as string"
            },
            "country": {
              "type": "string",
              "description": "Country name"
            }
          },
          "required": []
        }
      }
    },
    "required": [
      "id"
    ]
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
  "description": "Create a note on a person.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": {
        "type": "integer",
        "description": "Person ID."
      },
      "subject": {
        "type": "string",
        "description": "Note title."
      },
      "body": {
        "type": "string",
        "description": "Note content."
      },
      "isHtml": {
        "type": "boolean",
        "description": "true = render HTML tags in body."
      }
    },
    "required": [
      "personId"
    ]
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
  "description": "Update a note. Send only fields to change.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Note ID."
      },
      "personId": {
        "type": "integer",
        "description": "Person the note belongs to."
      },
      "subject": {
        "type": "string",
        "description": "Note title."
      },
      "body": {
        "type": "string",
        "description": "Note content."
      },
      "isHtml": {
        "type": "boolean",
        "description": "true = render HTML tags in body."
      }
    },
    "required": [
      "id"
    ]
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
  "description": "List calls, filterable by person or phone numbers.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "personId": {
        "type": "integer",
        "description": "Calls for this person."
      },
      "phone": {
        "type": "string",
        "description": "Person's phone; matches incoming and outgoing."
      },
      "toNumber": {
        "type": "string",
        "description": "Number called."
      },
      "fromNumber": {
        "type": "string",
        "description": "Number called from."
      }
    },
    "required": []
  }
},
{
  "name": "createCall",
  "description": "Log a call on a person. personId, phone, and isIncoming are required. userId can only be set by administrators (defaults to API user).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": {
        "type": "integer",
        "description": "Person ID."
      },
      "phone": {
        "type": "string",
        "description": "Phone number on the call."
      },
      "isIncoming": {
        "type": "boolean",
        "description": "true = incoming, false = outgoing."
      },
      "note": {
        "type": "string",
        "description": "Call log message."
      },
      "outcome": {
        "type": "string",
        "description": "Call outcome.",
        "enum": [
          "Interested",
          "Not Interested",
          "Left Message",
          "No Answer",
          "Busy",
          "Bad Number"
        ]
      },
      "duration": {
        "type": "integer",
        "description": "Seconds."
      },
      "toNumber": {
        "type": "string",
        "description": "Number called."
      },
      "fromNumber": {
        "type": "string",
        "description": "Number called from."
      },
      "userId": {
        "type": "integer",
        "description": "User who took the call; admin only."
      },
      "recordingUrl": {
        "type": "string",
        "description": "URL of the call recording."
      }
    },
    "required": [
      "personId",
      "phone",
      "isIncoming"
    ]
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
  "description": "Update a call record. Only calls created by the same API system/account can be updated.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Call ID."
      },
      "personId": {
        "type": "integer",
        "description": "Person ID."
      },
      "phone": {
        "type": "string",
        "description": "Phone number."
      },
      "isIncoming": {
        "type": "boolean",
        "description": "true = incoming."
      },
      "duration": {
        "type": "integer",
        "description": "Seconds."
      },
      "userId": {
        "type": "integer",
        "description": "User ID; admin only."
      },
      "note": {
        "type": "string",
        "description": "Call log message."
      },
      "outcome": {
        "type": "string",
        "description": "Call outcome.",
        "enum": [
          "Interested",
          "Not Interested",
          "Left Message",
          "No Answer",
          "Busy",
          "Bad Number"
        ]
      },
      "toNumber": {
        "type": "string",
        "description": "Number called."
      },
      "fromNumber": {
        "type": "string",
        "description": "Number called from."
      }
    },
    "required": [
      "id"
    ]
  }
},

// ==================== TEXT MESSAGES ====================
{
  "name": "listTextMessages",
  "description": "List text messages. FUB requires at least one filter: personId, phone, toNumber, fromNumber, threadId, sharedInboxId, groupTextId, participants or id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "personId": {
        "type": "integer",
        "description": "Messages for this person."
      },
      "toNumber": {
        "type": "string",
        "description": "Messages sent to this number."
      },
      "fromNumber": {
        "type": "string",
        "description": "Messages sent from this number."
      },
      "threadId": {
        "type": "string",
        "description": "Filter by thread ID"
      },
      "phone": {
        "type": "string",
        "description": "Filter by phone"
      },
      "sharedInboxId": {
        "type": "number",
        "description": "Filter by shared inbox"
      },
      "groupTextId": {
        "type": "number",
        "description": "Filter by group text"
      },
      "participants": {
        "type": "string",
        "description": "Comma-separated participants"
      },
      "id": {
        "type": "string",
        "description": "Comma-separated message IDs"
      }
    },
    "required": []
  }
},
{
  "name": "createTextMessage",
  "description": "LOG a text already sent by a registered SMS system; it does not send anything. Needs X-System credentials. personId, message, toNumber, fromNumber are all required.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": {
        "type": "integer",
        "description": "Person ID."
      },
      "message": {
        "type": "string",
        "description": "Message body."
      },
      "toNumber": {
        "type": "string",
        "description": "Recipient number."
      },
      "fromNumber": {
        "type": "string",
        "description": "Sender number."
      },
      "isIncoming": {
        "type": "boolean",
        "description": "true = from the person. Default false."
      },
      "externalLabel": {
        "type": "string",
        "description": "Byline text on the timeline."
      },
      "externalUrl": {
        "type": "string",
        "description": "Link shown in the timeline byline."
      }
    },
    "required": [
      "personId",
      "message",
      "toNumber",
      "fromNumber"
    ]
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
  "description": "List users (agents, brokers, lenders). Filter by role, exact name, or email.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "sort": {
        "type": "string",
        "description": "Sort field.",
        "enum": [
          "id",
          "name",
          "created"
        ]
      },
      "fields": {
        "type": "string",
        "description": "Comma-separated fields, or allFields. Add 'calling' for calling info (allFields,calling)."
      },
      "role": {
        "type": "string",
        "description": "User role.",
        "enum": [
          "Broker",
          "Agent",
          "Lender"
        ]
      },
      "name": {
        "type": "string",
        "description": "Exact full name (no partial match)."
      },
      "email": {
        "type": "string",
        "description": "Email address."
      },
      "includeDeleted": {
        "type": "boolean",
        "description": "Include deleted users. Default false."
      },
      "id": {
        "type": "string",
        "description": "Comma-separated user IDs"
      }
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
  "description": "Delete a user by ID. Admin only. Docs page param table unreadable; a reassignTo option may exist but is unverified.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "User ID."
      }
    },
    "required": [
      "id"
    ]
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
  "description": "List action plans. Filter by status, names, or IDs.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "sort": {
        "type": "string",
        "description": "Sort field, e.g. id or name."
      },
      "status": {
        "type": "string",
        "description": "Active, Deleted, or 'Active,Deleted' for both."
      },
      "names": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Plan names to match (names[]=...)."
      },
      "ids": {
        "type": "string",
        "description": "Comma-separated plan IDs."
      }
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
  "description": "List Automations 2.0 automations. Needs registered-system credentials and Automations 2.0.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "status": {
        "type": "string",
        "description": "Filter by status.",
        "enum": [
          "Active",
          "Disabled",
          "Deleted"
        ]
      },
      "enabledOnly": {
        "type": "boolean",
        "description": "Only enabled. Default false."
      },
      "manualOnly": {
        "type": "boolean",
        "description": "Only automations with a manual trigger. Default false."
      }
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
  "description": "List person/automation pairings. Needs registered-system credentials.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call. Default 10, max 100."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip. Default 0. Prefer next for deep paging."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous page."
      },
      "personId": {
        "type": "integer",
        "description": "Pairings for this person."
      },
      "automationId": {
        "type": "integer",
        "description": "Pairings for this automation."
      },
      "status": {
        "type": "string",
        "description": "Filter by run status.",
        "enum": [
          "Initial",
          "Running",
          "Paused",
          "Completed"
        ]
      }
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
  "description": "Pause or resume a person in an automation. Needs registered-system credentials.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "AutomationPerson ID."
      },
      "status": {
        "type": "string",
        "description": "Paused pauses; Running resumes.",
        "enum": [
          "Running",
          "Paused"
        ]
      }
    },
    "required": [
      "id"
    ]
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
  "description": "Create an email template. Merge fields (e.g. %contact_first_name%) work only in subject and body.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Template name"
      },
      "subject": {
        "type": "string",
        "description": "Email subject (merge fields allowed)"
      },
      "body": {
        "type": "string",
        "description": "HTML body (merge fields allowed)"
      },
      "isShared": {
        "type": "boolean",
        "description": "Share with other users in the account"
      }
    },
    "required": [
      "name",
      "subject",
      "body"
    ]
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
  "description": "Update an email template. Merge fields work only in subject and body.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Template ID"
      },
      "name": {
        "type": "string",
        "description": "Template name"
      },
      "subject": {
        "type": "string",
        "description": "Email subject"
      },
      "body": {
        "type": "string",
        "description": "HTML body"
      },
      "isShared": {
        "type": "boolean",
        "description": "Share with other users in the account"
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "mergeTemplate",
  "description": "Merge an email template with a person's data and return the rendered email. Does not send anything.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "templateId": {
        "type": "number",
        "description": "Email template ID"
      },
      "mergePersonId": {
        "type": "number",
        "description": "Person ID whose data fills merge fields like %contact_name%"
      },
      "recipients": {
        "type": "object",
        "description": "Recipients in the To: field. cc/bcc/from are unused by FUB.",
        "properties": {
          "to": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "email": {
                  "type": "string",
                  "description": "Recipient email"
                },
                "name": {
                  "type": "string",
                  "description": "Recipient name"
                }
              }
            }
          }
        }
      }
    },
    "required": []
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
  "description": "Create a text message template. Message text goes in `message`.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Template name"
      },
      "message": {
        "type": "string",
        "description": "Text message body (merge fields allowed)"
      },
      "isShared": {
        "type": "boolean",
        "description": "Share with other users in the account"
      }
    },
    "required": [
      "name",
      "message"
    ]
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
  "description": "Update a text message template. Message text goes in `message`.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Template ID"
      },
      "name": {
        "type": "string",
        "description": "Template name"
      },
      "message": {
        "type": "string",
        "description": "Text message body"
      },
      "isShared": {
        "type": "boolean",
        "description": "Share with other users in the account"
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "mergeTextMessageTemplate",
  "description": "Merge a text message template with a person's data and return the rendered text. Does not send anything.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "templateId": {
        "type": "number",
        "description": "Text message template ID"
      },
      "personId": {
        "type": "number",
        "description": "Person ID whose data fills merge fields (docs example uses mergePersonId)"
      },
      "recipients": {
        "type": "object",
        "description": "Recipients. from is unused by FUB.",
        "properties": {
          "to": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "Recipient name"
                },
                "phone": {
                  "type": "string",
                  "description": "Recipient phone"
                }
              }
            }
          }
        }
      }
    },
    "required": [
      "templateId"
    ]
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
  "description": "List email marketing events (delivered, opened, clicked, etc).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "enum": [
          "delivered",
          "open",
          "click",
          "bounced",
          "soft-bounce",
          "hard-bounce",
          "unsubscribe",
          "spamreport",
          "dropped"
        ],
        "description": "Filter by event type"
      },
      "personId": {
        "type": "number",
        "description": "Filter by person ID"
      },
      "updatedAfter": {
        "type": "string",
        "description": "ISO date-time; events created or updated after this"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      }
    },
    "required": []
  }
},
{
  "name": "createEmEvent",
  "description": "Send email marketing events to FUB, up to 1000 per call. Recipients with no matching contact are skipped and listed in recipientsNotFound.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "emEvents": {
        "type": "array",
        "description": "Event objects (max 1000)",
        "items": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "enum": [
                "delivered",
                "open",
                "click",
                "bounced",
                "soft-bounce",
                "hard-bounce",
                "unsubscribe",
                "spamreport",
                "dropped"
              ],
              "description": "Event type"
            },
            "occurred": {
              "type": "string",
              "description": "Date-time of the event, ISO 8601"
            },
            "recipient": {
              "type": "string",
              "description": "Recipient email address"
            },
            "personId": {
              "type": "number",
              "description": "FUB person ID of the recipient"
            },
            "campaignId": {
              "type": "string",
              "description": "Campaign id returned by createEmCampaign"
            },
            "userId": {
              "type": "number",
              "description": "Sending user ID; defaults to the API key's user"
            },
            "url": {
              "type": "string",
              "description": "URL for the campaign"
            }
          }
        }
      }
    },
    "required": [
      "emEvents"
    ]
  }
},
{
  "name": "listEmCampaigns",
  "description": "List email marketing campaigns, optionally by origin system and origin ID.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "origin": {
        "type": "string",
        "description": "Only campaigns from this origin system"
      },
      "originId": {
        "type": "string",
        "description": "Only the campaign with this ID in the origin system"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      }
    },
    "required": []
  }
},
{
  "name": "createEmCampaign",
  "description": "Create an email marketing campaign. The origin + originId pair must be unique; never reuse it. Subject and bodyHtml support merge fields.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "origin": {
        "type": "string",
        "description": "Name of the originating email marketing system"
      },
      "originId": {
        "type": "string",
        "description": "Your unique ID for the campaign in that system"
      },
      "name": {
        "type": "string",
        "description": "Campaign or template name"
      },
      "subject": {
        "type": "string",
        "description": "Email subject (merge fields allowed)"
      },
      "bodyHtml": {
        "type": "string",
        "description": "HTML body (merge fields allowed)"
      }
    },
    "required": [
      "origin",
      "originId"
    ]
  }
},
{
  "name": "updateEmCampaign",
  "description": "Update an email campaign's subject or body. Only account owners and admins can do this. Merge fields are allowed.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Campaign ID"
      },
      "origin": {
        "type": "string",
        "description": "Origin"
      },
      "originId": {
        "type": "string",
        "description": "Origin ID"
      },
      "name": {
        "type": "string",
        "description": "Name"
      },
      "subject": {
        "type": "string",
        "description": "Subject (merge fields allowed)"
      },
      "bodyHtml": {
        "type": "string",
        "description": "HTML body (merge fields allowed)"
      }
    },
    "required": [
      "id"
    ]
  }
},

// ==================== CUSTOM FIELDS ====================
{
  "name": "listCustomFields",
  "description": "List custom fields. Use limit=100 to get all in one call.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "description": "Find a custom field by its label"
      },
      "sort": {
        "type": "string",
        "enum": [
          "id",
          "name",
          "orderWeight",
          "-id",
          "-name",
          "-orderWeight"
        ],
        "description": "Sort field; '-' prefix = descending. Default -id"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      }
    },
    "required": []
  }
},
{
  "name": "createCustomField",
  "description": "Create a custom field (account owners only). The type cannot be changed later.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "description": "User-facing field name, e.g. Anniversary"
      },
      "type": {
        "type": "string",
        "enum": [
          "text",
          "date",
          "number",
          "dropdown"
        ],
        "description": "Field type; fixed after creation"
      },
      "choices": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Options for a dropdown field"
      },
      "isRecurring": {
        "type": "boolean",
        "description": "Date fields only: recurs yearly (birthdays). Default false"
      },
      "hideIfEmpty": {
        "type": "boolean",
        "description": "Hide on the person view when empty. Default false"
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort weight. Default 0"
      }
    },
    "required": [
      "label",
      "type"
    ]
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
  "description": "Update a custom field (account owners only). The type cannot be changed; delete and recreate instead.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Custom field ID"
      },
      "label": {
        "type": "string",
        "description": "User-facing field name"
      },
      "choices": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Options for a dropdown field"
      },
      "isRecurring": {
        "type": "boolean",
        "description": "Date fields only: recurs yearly"
      },
      "hideIfEmpty": {
        "type": "boolean",
        "description": "Hide on the person view when empty"
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort weight"
      }
    },
    "required": [
      "id"
    ]
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
  "description": "List pipeline stages. Default sort is orderWeight.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sort": {
        "type": "string",
        "enum": [
          "orderWeight",
          "id",
          "name"
        ],
        "description": "Sort field. Default orderWeight"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call."
      }
    },
    "required": []
  }
},
{
  "name": "createStage",
  "description": "Create a stage. orderWeight defaults to 1000; FUB then renumbers all stages in steps of 1000.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Stage name"
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort position. Default 1000"
      }
    },
    "required": [
      "name"
    ]
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
  "description": "Update a stage's name or position. Stages with isProtected=true cannot be renamed. FUB renumbers all stage weights in steps of 1000.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Stage ID"
      },
      "name": {
        "type": "string",
        "description": "Stage name (not allowed if isProtected)"
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort position"
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "deleteStage",
  "description": "Delete a lead stage. FUB requires assignStageId: the stage that people in the deleted stage move to (listStages gives IDs).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Stage ID" },
      "assignStageId": { "type": "number", "description": "Stage that people in the deleted stage move to. Required by FUB." }
    },
    "required": ["id", "assignStageId"]
  }
},

// ==================== TASKS ====================
{
  "name": "listTasks",
  "description": "List tasks. Use due=overdue for overdue tasks, due=today for today's, assignedUserId for one user's tasks, personId for one contact's. Add isCompleted=false for open tasks only. Filters combine.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": {
        "type": "number",
        "description": "Tasks for this person ID"
      },
      "assignedUserId": {
        "type": "number",
        "description": "Tasks assigned to this user ID"
      },
      "assignedTo": {
        "type": "string",
        "description": "Tasks assigned to this user's full name"
      },
      "name": {
        "type": "string",
        "description": "Tasks whose name contains this text"
      },
      "type": {
        "type": "string",
        "description": "Task type; comma-separated list. Values: Follow Up, Call, Email, Text, Appointment, Showing, Closing, Open House, Thank You"
      },
      "isCompleted": {
        "type": "boolean",
        "description": "true = completed only, false = open only"
      },
      "due": {
        "type": "string",
        "enum": [
          "today",
          "overdue",
          "upcoming"
        ],
        "description": "Due-date bucket"
      },
      "dueStart": {
        "type": "string",
        "description": "ISO date-time; tasks due from this time"
      },
      "dueEnd": {
        "type": "string",
        "description": "ISO date-time; tasks due at or before this time"
      },
      "sort": {
        "type": "string",
        "description": "Sort order"
      },
      "fields": {
        "type": "string",
        "description": "Comma-separated fields to return"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call."
      }
    },
    "required": []
  }
},
{
  "name": "createTask",
  "description": "Create a task on a person. personId is required, and one of assignedUserId or assignedTo is required. dueDate is YYYY-MM-DD; use dueDateTime for a specific time.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": {
        "type": "number",
        "description": "Person the task relates to"
      },
      "assignedUserId": {
        "type": "number",
        "description": "User ID to assign"
      },
      "assignedTo": {
        "type": "string",
        "description": "Full name of the user to assign"
      },
      "name": {
        "type": "string",
        "description": "Task name"
      },
      "type": {
        "type": "string",
        "enum": [
          "Follow Up",
          "Call",
          "Email",
          "Text",
          "Appointment",
          "Showing",
          "Closing",
          "Open House",
          "Thank You"
        ],
        "description": "Task category"
      },
      "isCompleted": {
        "type": "boolean",
        "description": "Mark completed or not"
      },
      "dueDate": {
        "type": "string",
        "description": "Due date, YYYY-MM-DD"
      },
      "dueDateTime": {
        "type": "string",
        "description": "Due date-time with optional offset, e.g. 2026-11-02T15:00:00-05:00"
      },
      "remindSecondsBefore": {
        "type": "number",
        "description": "Reminder lead time in seconds; only for tasks with a due time"
      }
    },
    "required": []
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
  "description": "Update a task. Mark done with isCompleted=true. dueDate is YYYY-MM-DD; use dueDateTime for a specific time.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Task ID"
      },
      "personId": {
        "type": "number",
        "description": "Person the task relates to"
      },
      "assignedUserId": {
        "type": "number",
        "description": "User ID to assign"
      },
      "assignedTo": {
        "type": "string",
        "description": "Full name of the user to assign"
      },
      "name": {
        "type": "string",
        "description": "Task name"
      },
      "type": {
        "type": "string",
        "enum": [
          "Follow Up",
          "Call",
          "Email",
          "Text",
          "Appointment",
          "Showing",
          "Closing",
          "Open House",
          "Thank You"
        ],
        "description": "Task category"
      },
      "isCompleted": {
        "type": "boolean",
        "description": "Mark completed or not"
      },
      "dueDate": {
        "type": "string",
        "description": "Due date, YYYY-MM-DD"
      },
      "dueDateTime": {
        "type": "string",
        "description": "Due date-time with optional offset, e.g. 2026-11-02T15:00:00-05:00"
      },
      "remindSecondsBefore": {
        "type": "number",
        "description": "Reminder lead time in seconds; only for tasks with a due time"
      }
    },
    "required": [
      "id"
    ]
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
  "description": "List appointments. Filter by personId (comma list allowed), userId, or a start+end date range (both required together).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": {
        "type": "string",
        "description": "Person ID; comma-separated list allowed"
      },
      "userId": {
        "type": "number",
        "description": "Appointments for this user ID"
      },
      "start": {
        "type": "string",
        "description": "Range start (date); must be used with end"
      },
      "end": {
        "type": "string",
        "description": "Range end (date); must be used with start"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call."
      }
    },
    "required": []
  }
},
{
  "name": "createAppointment",
  "description": "Create an appointment. Use start/end (UTC; offset suffix allowed), typeId/outcomeId, invitees [{userId}] or [{personId}]. sendInvitation=true emails invitees (SMS too if reminders are on); default false.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "Appointment title"
      },
      "start": {
        "type": "string",
        "description": "Start, ISO 8601 UTC or with offset"
      },
      "end": {
        "type": "string",
        "description": "End, ISO 8601 UTC or with offset"
      },
      "description": {
        "type": "string",
        "description": "Description"
      },
      "invitees": {
        "type": "array",
        "description": "People/users to invite: [{userId}] for a user, [{personId}] for a contact (optional name, email).",
        "items": {
          "type": "object",
          "properties": {
            "userId": {
              "type": "number",
              "description": "FUB user ID"
            },
            "personId": {
              "type": "number",
              "description": "FUB person ID"
            },
            "name": {
              "type": "string",
              "description": "Display name"
            },
            "email": {
              "type": "string",
              "description": "Email (people)"
            }
          }
        }
      },
      "allDay": {
        "type": "boolean",
        "description": "All-day event. Default false"
      },
      "location": {
        "type": "string",
        "description": "Location or address"
      },
      "typeId": {
        "type": "number",
        "description": "Appointment type ID (see listAppointmentTypes)"
      },
      "outcomeId": {
        "type": "number",
        "description": "Appointment outcome ID (see listAppointmentOutcomes)"
      },
      "createdById": {
        "type": "number",
        "description": "Creator user ID; admins only"
      },
      "sendInvitation": {
        "type": "boolean",
        "description": "Query param: email invitees. Default false"
      }
    },
    "required": [
      "title",
      "start",
      "end"
    ]
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
  "description": "Update an appointment. FUB requires `start` and `end` on EVERY update (even partial edits) or it returns 'Valid Start and End dates are required'. Refetch with getAppointment first if you only have the id. Invitees: [{userId:int}] for a FUB user, [{personId:int}] for a contact (optional name/email). The shape {type,id} is NOT FUB's; it is auto-converted, but prefer userId/personId. This tool never sends invitation emails (sendInvitation is not sent; FUB's default is off), but FUB syncs appointments to Google/Outlook calendars for invitees, so a person invitee may still get a calendar invite from the calendar side.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Appointment ID" },
      "title": { "type": "string" },
      "start": { "type": "string", "description": "Start ISO" },
      "end": { "type": "string", "description": "End ISO" },
      "description": { "type": "string" },
      "invitees": { "type": "array", "description": "Array of {userId:int} (FUB user) and/or {personId:int} (contact)", "items": { "type": "object" } },
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
  "description": "List appointment types. Default sort is orderWeight.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sort": {
        "type": "string",
        "enum": [
          "id",
          "name",
          "orderWeight",
          "-id",
          "-name",
          "-orderWeight"
        ],
        "description": "Sort field; '-' prefix = descending. Default orderWeight"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call."
      }
    },
    "required": []
  }
},
{
  "name": "createAppointmentType",
  "description": "Create an appointment type (account owner only).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Type name"
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort position"
      }
    },
    "required": []
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
  "description": "Update an appointment type (account owner only).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Type ID"
      },
      "name": {
        "type": "string",
        "description": "Name"
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort position"
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "deleteAppointmentType",
  "description": "Delete an appointment type. FUB requires assignTypeId: the type that appointments of the deleted type move to (listAppointmentTypes gives IDs).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Type ID" },
      "assignTypeId": { "type": "number", "description": "Appointment type that existing appointments move to. Required by FUB." }
    },
    "required": ["id", "assignTypeId"]
  }
},

// ==================== APPOINTMENT OUTCOMES ====================
{
  "name": "listAppointmentOutcomes",
  "description": "List appointment outcomes. Default sort is orderWeight.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sort": {
        "type": "string",
        "enum": [
          "id",
          "name",
          "orderWeight",
          "-id",
          "-name",
          "-orderWeight"
        ],
        "description": "Sort field; '-' prefix = descending. Default orderWeight"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call."
      }
    },
    "required": []
  }
},
{
  "name": "createAppointmentOutcome",
  "description": "Create an appointment outcome (account owner only).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Outcome name"
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort position"
      }
    },
    "required": []
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
  "description": "Update an appointment outcome (account owner only).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Outcome ID"
      },
      "name": {
        "type": "string",
        "description": "Name"
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort position"
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "deleteAppointmentOutcome",
  "description": "Delete an appointment outcome. FUB requires assignOutcomeId: the outcome that appointments with the deleted outcome move to (listAppointmentOutcomes gives IDs).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Outcome ID" },
      "assignOutcomeId": { "type": "number", "description": "Appointment outcome that existing appointments move to. Required by FUB." }
    },
    "required": ["id", "assignOutcomeId"]
  }
},

// ==================== WEBHOOKS ====================
{
  "name": "listWebhooks",
  "description": "List webhooks. Account owner or registered system only. Filter by event or status.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "event": {
        "type": "string",
        "enum": [
          "peopleCreated",
          "peopleUpdated",
          "peopleDeleted",
          "peopleTagsCreated",
          "peopleStageUpdated",
          "peopleRelationshipCreated",
          "peopleRelationshipUpdated",
          "peopleRelationshipDeleted",
          "notesCreated",
          "notesUpdated",
          "notesDeleted",
          "emEventsOpened",
          "emEventsClicked",
          "emEventsUnsubscribed",
          "tasksCreated",
          "tasksUpdated",
          "tasksDeleted",
          "appointmentsCreated",
          "appointmentsUpdated",
          "appointmentsDeleted",
          "textMessagesCreated",
          "textMessagesUpdated",
          "textMessagesDeleted",
          "callsCreated",
          "callsUpdated",
          "callsDeleted",
          "dealsCreated",
          "dealsUpdated",
          "dealsDeleted",
          "emailsCreated",
          "emailsUpdated",
          "emailsDeleted",
          "eventsCreated",
          "stageCreated",
          "stageUpdated",
          "stageDeleted"
        ],
        "description": "Only webhooks for this event"
      },
      "status": {
        "type": "string",
        "enum": [
          "Active",
          "Disabled"
        ],
        "description": "Only webhooks with this status"
      },
      "sort": {
        "type": "string",
        "enum": [
          "id",
          "created",
          "updated",
          "status",
          "event"
        ],
        "description": "Sort field. Default created"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call."
      }
    },
    "required": []
  }
},
{
  "name": "createWebhook",
  "description": "Create a webhook for one event. url must be https. Account owner or registered system only.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "event": {
        "type": "string",
        "enum": [
          "peopleCreated",
          "peopleUpdated",
          "peopleDeleted",
          "peopleTagsCreated",
          "peopleStageUpdated",
          "peopleRelationshipCreated",
          "peopleRelationshipUpdated",
          "peopleRelationshipDeleted",
          "notesCreated",
          "notesUpdated",
          "notesDeleted",
          "emEventsOpened",
          "emEventsClicked",
          "emEventsUnsubscribed",
          "tasksCreated",
          "tasksUpdated",
          "tasksDeleted",
          "appointmentsCreated",
          "appointmentsUpdated",
          "appointmentsDeleted",
          "textMessagesCreated",
          "textMessagesUpdated",
          "textMessagesDeleted",
          "callsCreated",
          "callsUpdated",
          "callsDeleted",
          "dealsCreated",
          "dealsUpdated",
          "dealsDeleted",
          "emailsCreated",
          "emailsUpdated",
          "emailsDeleted",
          "eventsCreated",
          "stageCreated",
          "stageUpdated",
          "stageDeleted"
        ],
        "description": "Event the webhook fires on"
      },
      "url": {
        "type": "string",
        "description": "Callback URL; must be https"
      }
    },
    "required": [
      "event",
      "url"
    ]
  }
},
{
  "name": "getWebhook",
  "description": "Get a webhook by ID. Account owner or registered system only.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Webhook ID"
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "updateWebhook",
  "description": "Update a webhook. url must be https. Account owner or registered system only.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Webhook ID"
      },
      "event": {
        "type": "string",
        "enum": [
          "peopleCreated",
          "peopleUpdated",
          "peopleDeleted",
          "peopleTagsCreated",
          "peopleStageUpdated",
          "peopleRelationshipCreated",
          "peopleRelationshipUpdated",
          "peopleRelationshipDeleted",
          "notesCreated",
          "notesUpdated",
          "notesDeleted",
          "emEventsOpened",
          "emEventsClicked",
          "emEventsUnsubscribed",
          "tasksCreated",
          "tasksUpdated",
          "tasksDeleted",
          "appointmentsCreated",
          "appointmentsUpdated",
          "appointmentsDeleted",
          "textMessagesCreated",
          "textMessagesUpdated",
          "textMessagesDeleted",
          "callsCreated",
          "callsUpdated",
          "callsDeleted",
          "dealsCreated",
          "dealsUpdated",
          "dealsDeleted",
          "emailsCreated",
          "emailsUpdated",
          "emailsDeleted",
          "eventsCreated",
          "stageCreated",
          "stageUpdated",
          "stageDeleted"
        ],
        "description": "Event the webhook fires on"
      },
      "url": {
        "type": "string",
        "description": "Callback URL; must be https"
      }
    },
    "required": [
      "id"
    ]
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
  "description": "Get the events delivered for a webhook (id, eventCreated, event, resourceIds, uri). Account owner or registered system only.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Webhook ID"
      }
    },
    "required": [
      "id"
    ]
  }
},

// ==================== PIPELINES ====================
{
  "name": "listPipelines",
  "description": "List pipelines, optionally by exact name.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Exact pipeline name to look up"
      },
      "limit": {
        "type": "number",
        "description": "Results to return. FUB default 10, max 100."
      },
      "offset": {
        "type": "number",
        "description": "Rows to skip before results begin. Default 0."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call."
      }
    },
    "required": []
  }
},
{
  "name": "createPipeline",
  "description": "Create a pipeline with optional stages (account owner only). Each stage needs name and closedStage.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Pipeline name"
      },
      "description": {
        "type": "string",
        "description": "Pipeline description"
      },
      "stages": {
        "type": "array",
        "description": "Stages. Include id to update an existing stage; omit id to create one.",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "number",
              "description": "Existing stage ID (update only)"
            },
            "name": {
              "type": "string",
              "description": "Stage name"
            },
            "closedStage": {
              "type": "boolean",
              "description": "True if a closed stage"
            },
            "description": {
              "type": "string",
              "description": "Stage description"
            },
            "orderWeight": {
              "type": "number",
              "description": "Sort position"
            },
            "color": {
              "type": "string",
              "description": "Hex color, e.g. #FFFFFF"
            }
          },
          "required": [
            "name",
            "closedStage"
          ]
        }
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort position"
      }
    },
    "required": [
      "name"
    ]
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
  "description": "Update a pipeline and its stages (owner only). Stages with id are updated, without id are created.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Pipeline ID"
      },
      "name": {
        "type": "string",
        "description": "Pipeline name"
      },
      "description": {
        "type": "string",
        "description": "Pipeline description"
      },
      "stages": {
        "type": "array",
        "description": "Stages. Include id to update an existing stage; omit id to create one.",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "number",
              "description": "Existing stage ID (update only)"
            },
            "name": {
              "type": "string",
              "description": "Stage name"
            },
            "closedStage": {
              "type": "boolean",
              "description": "True if a closed stage"
            },
            "description": {
              "type": "string",
              "description": "Stage description"
            },
            "orderWeight": {
              "type": "number",
              "description": "Sort position"
            },
            "color": {
              "type": "string",
              "description": "Hex color, e.g. #FFFFFF"
            }
          },
          "required": [
            "name",
            "closedStage"
          ]
        }
      },
      "orderWeight": {
        "type": "number",
        "description": "Sort position"
      }
    },
    "required": [
      "id"
    ]
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
  "description": "List deals, filtered by pipeline, user, person or status. Archived and Deleted deals are hidden unless includeArchived=1 or includeDeleted=1. Use getDeal for one deal by ID.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call, max 100. Not set by server; FUB default is 10 when omitted."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip before returning results."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call for the next page."
      },
      "sort": {
        "type": "string",
        "description": "Sort field; prefix with - for descending."
      },
      "fields": {
        "type": "string",
        "description": "Comma-separated list of fields to return."
      },
      "pipelineId": {
        "type": "integer",
        "description": "Return deals for this pipeline only."
      },
      "userId": {
        "type": "integer",
        "description": "Return deals for this user."
      },
      "personId": {
        "type": "integer",
        "description": "Return deals for this person."
      },
      "includeArchived": {
        "type": "integer",
        "description": "Set to 1 to include deals with status Archived."
      },
      "includeDeleted": {
        "type": "integer",
        "description": "Set to 1 to include deals with status Deleted."
      },
      "status": {
        "type": "string",
        "description": "Only return deals with this status. To see Deleted deals use includeDeleted=1; status=Deleted returns all statuses.",
        "enum": [
          "Active",
          "Archived",
          "Deleted"
        ]
      },
      "stageId": {
        "type": "number",
        "description": "Filter by stage ID (from listStages). Works live although the docs omit it."
      },
      "id": {
        "type": "string",
        "description": "Comma-separated deal IDs"
      }
    },
    "required": []
  }
},
{
  "name": "createDeal",
  "description": "Create a deal. name and stageId are required. Use peopleIds (array) and price (whole number); do not use personId or value. Custom field values may be passed as extra properties (e.g. customField1).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Name of the deal."
      },
      "stageId": {
        "type": "integer",
        "description": "Stage the deal is assigned to."
      },
      "description": {
        "type": "string",
        "description": "Description of the deal."
      },
      "peopleIds": {
        "type": "array",
        "description": "Person IDs to include in the deal.",
        "items": {
          "type": "integer"
        }
      },
      "userIds": {
        "type": "array",
        "description": "User IDs to include in the deal.",
        "items": {
          "type": "integer"
        }
      },
      "price": {
        "type": "integer",
        "description": "Price associated with the deal (whole number)."
      },
      "projectedCloseDate": {
        "type": "string",
        "description": "Projected close date, YYYY-MM-DD.",
        "format": "date"
      },
      "commissionValue": {
        "type": "integer",
        "description": "Commission value for the deal."
      },
      "agentCommission": {
        "type": "integer",
        "description": "Commission split for the agent."
      },
      "teamCommission": {
        "type": "integer",
        "description": "Commission split for the team."
      },
      "earnestMoneyDueDate": {
        "type": "string",
        "description": "Earnest money due date, YYYY-MM-DD.",
        "format": "date"
      },
      "mutualAcceptanceDate": {
        "type": "string",
        "description": "Mutual acceptance date, YYYY-MM-DD.",
        "format": "date"
      },
      "dueDiligenceDate": {
        "type": "string",
        "description": "Due diligence date, YYYY-MM-DD.",
        "format": "date"
      },
      "finalWalkThroughDate": {
        "type": "string",
        "description": "Final walk-through date, YYYY-MM-DD.",
        "format": "date"
      },
      "possessionDate": {
        "type": "string",
        "description": "Possession date, YYYY-MM-DD.",
        "format": "date"
      },
      "orderWeight": {
        "type": "integer",
        "description": "Sets a specific sort order."
      }
    },
    "required": [
      "name",
      "stageId"
    ],
    "additionalProperties": true
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
  "description": "Update a deal by ID; send only fields to change. peopleIds and userIds replace the full list. Use peopleIds (not personId) and price (not value). Custom field values may be passed as extra properties (e.g. customField1).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Name of the deal."
      },
      "stageId": {
        "type": "integer",
        "description": "Stage the deal is assigned to."
      },
      "description": {
        "type": "string",
        "description": "Description of the deal."
      },
      "peopleIds": {
        "type": "array",
        "description": "Person IDs to include in the deal.",
        "items": {
          "type": "integer"
        }
      },
      "userIds": {
        "type": "array",
        "description": "User IDs to include in the deal.",
        "items": {
          "type": "integer"
        }
      },
      "price": {
        "type": "integer",
        "description": "Price associated with the deal (whole number)."
      },
      "projectedCloseDate": {
        "type": "string",
        "description": "Projected close date, YYYY-MM-DD.",
        "format": "date"
      },
      "commissionValue": {
        "type": "integer",
        "description": "Commission value for the deal."
      },
      "agentCommission": {
        "type": "integer",
        "description": "Commission split for the agent."
      },
      "teamCommission": {
        "type": "integer",
        "description": "Commission split for the team."
      },
      "earnestMoneyDueDate": {
        "type": "string",
        "description": "Earnest money due date, YYYY-MM-DD.",
        "format": "date"
      },
      "mutualAcceptanceDate": {
        "type": "string",
        "description": "Mutual acceptance date, YYYY-MM-DD.",
        "format": "date"
      },
      "dueDiligenceDate": {
        "type": "string",
        "description": "Due diligence date, YYYY-MM-DD.",
        "format": "date"
      },
      "finalWalkThroughDate": {
        "type": "string",
        "description": "Final walk-through date, YYYY-MM-DD.",
        "format": "date"
      },
      "possessionDate": {
        "type": "string",
        "description": "Possession date, YYYY-MM-DD.",
        "format": "date"
      },
      "id": {
        "type": "integer",
        "description": "Deal ID."
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": true
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
  "description": "Attach an externally hosted file to a deal by URI. Restricted to registered systems (needs FUB_SYSTEM and FUB_SYSTEM_KEY). FUB does not host uploads here; omitting uri returns 403.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "dealId": {
        "type": "integer",
        "description": "ID of the deal to attach to."
      },
      "uri": {
        "type": "string",
        "description": "URI of an externally hosted file."
      },
      "fileName": {
        "type": "string",
        "description": "Name of the file."
      },
      "fileSize": {
        "type": "integer",
        "description": "Size of the file in bytes."
      }
    },
    "required": [
      "dealId",
      "uri",
      "fileName"
    ]
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
  "description": "Update a deal attachment by ID. FUB requires dealId, uri and fileName on every update, even if unchanged.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Attachment ID."
      },
      "dealId": {
        "type": "integer",
        "description": "ID of the deal the attachment belongs to."
      },
      "uri": {
        "type": "string",
        "description": "URI of an externally hosted file."
      },
      "fileName": {
        "type": "string",
        "description": "Name of the file."
      },
      "fileSize": {
        "type": "integer",
        "description": "Size of the file in bytes."
      }
    },
    "required": [
      "id",
      "dealId",
      "uri",
      "fileName"
    ]
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
  "description": "List deal custom fields. Paginated: FUB returns 10 per page unless limit is set; pass limit=100 to get more in one call.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call, max 100. Not set by server; FUB default is 10 when omitted."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip before returning results."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call for the next page."
      },
      "sort": {
        "type": "string",
        "description": "Sort field; prefix with - for descending. FUB default is id descending.",
        "enum": [
          "id",
          "name",
          "orderWeight"
        ]
      },
      "label": {
        "type": "string",
        "description": "Find the custom field by label."
      }
    },
    "required": []
  }
},
{
  "name": "createDealCustomField",
  "description": "Create a deal custom field. Only the account owner can do this. label and type are required; choices applies only to dropdown fields.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "description": "User-friendly name of the field (e.g. Anniversary). Use label, not name."
      },
      "type": {
        "type": "string",
        "description": "Field type.",
        "enum": [
          "text",
          "date",
          "number",
          "dropdown"
        ]
      },
      "choices": {
        "type": "array",
        "description": "Options for a dropdown field. Use choices, not options.",
        "items": {
          "type": "string"
        }
      },
      "isRecurring": {
        "type": "boolean",
        "description": "Date field repeats every year (e.g. birthdays). FUB default false."
      },
      "hideIfEmpty": {
        "type": "boolean",
        "description": "Hide the field when empty. FUB default false."
      },
      "orderWeight": {
        "type": "integer",
        "description": "Weight for custom sorting. FUB default 0."
      },
      "readOnly": {
        "type": "boolean",
        "description": "Field is read only. FUB default false."
      }
    },
    "required": [
      "label",
      "type"
    ]
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
  "description": "Update a deal custom field by ID. Only the account owner can do this. Send only fields to change.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "description": "User-friendly name of the field (e.g. Anniversary). Use label, not name."
      },
      "type": {
        "type": "string",
        "description": "Field type: text, date, number or dropdown."
      },
      "choices": {
        "type": "array",
        "description": "Options for a dropdown field. Use choices, not options.",
        "items": {
          "type": "string"
        }
      },
      "isRecurring": {
        "type": "boolean",
        "description": "Date field repeats every year (e.g. birthdays). FUB default false."
      },
      "hideIfEmpty": {
        "type": "boolean",
        "description": "Hide the field when empty. FUB default false."
      },
      "orderWeight": {
        "type": "integer",
        "description": "Weight for custom sorting. FUB default 0."
      },
      "readOnly": {
        "type": "boolean",
        "description": "Field is read only. FUB default false."
      },
      "id": {
        "type": "integer",
        "description": "Field ID."
      }
    },
    "required": [
      "id"
    ]
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
  "description": "List lead-routing groups (not accessible to lender accounts). Returns up to 100 per call; if _metadata.next is set, call again with next.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call, max 100. Server sends 100 when omitted (FUB's own default is 10)."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip before returning results."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call for the next page."
      },
      "sort": {
        "type": "string",
        "description": "Sort field; prefix with - for descending.",
        "enum": [
          "id",
          "name"
        ]
      },
      "type": {
        "type": "string",
        "description": "Group type: Agent (admins and agents) or Lender (lender role users).",
        "enum": [
          "Agent",
          "Lender"
        ]
      }
    },
    "required": []
  }
},
{
  "name": "listRoundRobinGroups",
  "description": "List round robin groups, including each group's next round-robin user. Not accessible to lender accounts.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "description": "Group type: Agent (admins and agents) or Lender (lender role users).",
        "enum": [
          "Agent",
          "Lender"
        ]
      },
      "sort": {
        "type": "string",
        "description": "Sort field; prefix with - for descending.",
        "enum": [
          "id",
          "name"
        ]
      }
    },
    "required": []
  }
},
{
  "name": "createGroup",
  "description": "Create a lead-routing group. Admin accounts only. name and users (user IDs) are required; the member list key is users, not userIds.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Name of the group."
      },
      "users": {
        "type": "array",
        "description": "User IDs that are members of this group. Required by FUB.",
        "items": {
          "type": "integer"
        }
      },
      "distribution": {
        "type": "string",
        "description": "Distribution model. Lender groups cannot be first-to-claim. FUB default round-robin.",
        "enum": [
          "first-to-claim",
          "round-robin"
        ]
      },
      "type": {
        "type": "string",
        "description": "Group type. FUB default Agent.",
        "enum": [
          "Agent",
          "Lender"
        ]
      },
      "claimWindow": {
        "type": "integer",
        "description": "Seconds to claim a lead in a first-to-claim group, 1 to 30 minutes. FUB default 1800."
      },
      "defaultGroupId": {
        "type": "integer",
        "description": "Group that gets unclaimed first-to-claim leads after the claim window."
      },
      "defaultPondId": {
        "type": "integer",
        "description": "Pond that gets unclaimed first-to-claim leads after the claim window."
      },
      "defaultUserId": {
        "type": "integer",
        "description": "User who gets unclaimed first-to-claim leads after the claim window."
      }
    },
    "required": [
      "name",
      "users"
    ]
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
  "description": "Update a group by ID. Admin accounts only. Send only fields to change; the current users are kept when users is not sent.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Group ID."
      },
      "name": {
        "type": "string",
        "description": "Name of the group."
      },
      "users": {
        "type": "array",
        "description": "User IDs that are members of this group. Required by FUB.",
        "items": {
          "type": "integer"
        }
      },
      "distribution": {
        "type": "string",
        "description": "Distribution model. Lender groups cannot be first-to-claim. FUB default round-robin.",
        "enum": [
          "first-to-claim",
          "round-robin"
        ]
      },
      "type": {
        "type": "string",
        "description": "Group type. FUB default Agent.",
        "enum": [
          "Agent",
          "Lender"
        ]
      },
      "claimWindow": {
        "type": "integer",
        "description": "Seconds to claim a lead in a first-to-claim group, 1 to 30 minutes. FUB default 1800."
      },
      "defaultGroupId": {
        "type": "integer",
        "description": "Group that gets unclaimed first-to-claim leads after the claim window."
      },
      "defaultPondId": {
        "type": "integer",
        "description": "Pond that gets unclaimed first-to-claim leads after the claim window."
      },
      "defaultUserId": {
        "type": "integer",
        "description": "User who gets unclaimed first-to-claim leads after the claim window."
      }
    },
    "required": [
      "id"
    ]
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
  "description": "List teams with their userIds and leaderIds. Returns up to 100 per call; if _metadata.next is set, call again with next.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call, max 100. Server sends 100 when omitted (FUB's own default is 10)."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip before returning results."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call for the next page."
      }
    },
    "required": []
  }
},
{
  "name": "createTeam",
  "description": "Create a team. name and userIds (all member user IDs) are required; leaderIds is the complete list of team leaders. Needs team access (403 otherwise).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Name of the team."
      },
      "userIds": {
        "type": "array",
        "description": "User IDs that are members of the team.",
        "items": {
          "type": "integer"
        }
      },
      "leaderIds": {
        "type": "array",
        "description": "Complete list of team leader user IDs.",
        "items": {
          "type": "integer"
        }
      }
    },
    "required": [
      "name",
      "userIds"
    ]
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
  "description": "Update a team by ID. If userIds or leaderIds is sent, send the COMPLETE list; it replaces the existing one.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Team ID."
      },
      "name": {
        "type": "string",
        "description": "Name of the team."
      },
      "description": {
        "type": "string",
        "description": "Team description (not in FUB docs; may be ignored)."
      },
      "userIds": {
        "type": "array",
        "description": "Complete list of member user IDs.",
        "items": {
          "type": "integer"
        }
      },
      "leaderIds": {
        "type": "array",
        "description": "Complete list of team leader user IDs.",
        "items": {
          "type": "integer"
        }
      }
    },
    "required": [
      "id"
    ]
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
  "description": "List team inboxes with their users. Returns up to 100 per call; if _metadata.next is set, call again with next.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call, max 100. Server sends 100 when omitted (FUB's own default is 10)."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip before returning results."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call for the next page."
      }
    },
    "required": []
  }
},

// ==================== PONDS ====================
{
  "name": "listPonds",
  "description": "List ponds (shared lead pools). Returns up to 100 per call; if _metadata.next is set, call again with next.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call, max 100. Server sends 100 when omitted (FUB's own default is 10)."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip before returning results."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call for the next page."
      }
    },
    "required": []
  }
},
{
  "name": "createPond",
  "description": "Create a pond. name, userId (the pond lead agent) and userIds (all member user IDs) are all required.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Name of the pond."
      },
      "userId": {
        "type": "integer",
        "description": "User ID of the pond lead agent."
      },
      "userIds": {
        "type": "array",
        "description": "User IDs of all pond members.",
        "items": {
          "type": "integer"
        }
      }
    },
    "required": [
      "name",
      "userId",
      "userIds"
    ]
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
  "description": "Update a pond by ID. If userIds is sent, send the COMPLETE member list; it replaces the existing one.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Pond ID."
      },
      "name": {
        "type": "string",
        "description": "Name of the pond."
      },
      "userIds": {
        "type": "array",
        "description": "Complete list of member user IDs.",
        "items": {
          "type": "integer"
        }
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "deletePond",
  "description": "Delete a pond. FUB requires assignTo: the user ID that gets the people in the deleted pond (listUsers gives IDs).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Pond ID" },
      "assignTo": { "type": "number", "description": "User ID that gets the people in the deleted pond. Required by FUB." }
    },
    "required": ["id", "assignTo"]
  }
},

// ==================== TIMEFRAMES ====================
{
  "name": "listTimeframes",
  "description": "List timeframes (lead time-to-buy options). Returns up to 100 per call; if _metadata.next is set, call again with next.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call, max 100. Server sends 100 when omitted (FUB's own default is 10)."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip before returning results."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call for the next page."
      }
    },
    "required": []
  }
},

// ==================== INBOX APPS ====================
{
  "name": "inboxAppAddMessage",
  "description": "Add a message to an inbox app conversation (creates the conversation on first use). Conversations are keyed by YOUR externalConversationId. person and owner are needed on the first message of a conversation.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "inboxAppId": {
        "type": "string",
        "description": "ID of the inbox app making the call."
      },
      "externalConversationId": {
        "type": "string",
        "description": "Your unique ID for the conversation."
      },
      "externalMessageId": {
        "type": "string",
        "description": "Your unique ID for the message."
      },
      "replyToExternalMessageId": {
        "type": "string",
        "description": "External ID of the message being replied to."
      },
      "sentAt": {
        "type": "string",
        "description": "Delivery time, ISO 8601 UTC. Defaults to now."
      },
      "subject": {
        "type": "string",
        "description": "Sets or updates the conversation subject."
      },
      "message": {
        "type": "string",
        "description": "Plain-text message body."
      },
      "isIncoming": {
        "type": "boolean",
        "description": "True if the message came in to your system."
      },
      "isAutomation": {
        "type": "boolean",
        "description": "True if the sender is an automated system. Default false."
      },
      "person": {
        "type": "object",
        "description": "Person on the conversation. Needed on the first message.",
        "properties": {
          "id": {
            "type": "integer",
            "description": "FUB Person ID."
          },
          "name": {
            "type": "string",
            "description": "Name, for people not yet in FUB."
          },
          "email": {
            "type": "string",
            "description": "Email, for people not yet in FUB."
          },
          "phone": {
            "type": "string",
            "description": "Phone, for people not yet in FUB."
          }
        }
      },
      "owner": {
        "type": "object",
        "description": "Conversation owner. Needed on the first message. Set userId OR inboxId, not both.",
        "properties": {
          "userId": {
            "type": "integer",
            "description": "FUB User who owns the conversation."
          },
          "inboxId": {
            "type": "string",
            "description": "FUB Team Inbox that owns the conversation."
          }
        }
      },
      "sender": {
        "type": "object",
        "description": "Message sender. Set one of userId, personId, relationshipId, participantId, or name/email/phone.",
        "properties": {
          "userId": {
            "type": "integer",
            "description": "FUB User ID."
          },
          "personId": {
            "type": "integer",
            "description": "FUB Person ID."
          },
          "relationshipId": {
            "type": "integer",
            "description": "FUB Relationship ID."
          },
          "participantId": {
            "type": "integer",
            "description": "Conversation participant ID."
          },
          "name": {
            "type": "string",
            "description": "Sender name if no ID is known."
          },
          "email": {
            "type": "string",
            "description": "Sender email if no ID is known."
          },
          "phone": {
            "type": "string",
            "description": "Sender phone if no ID is known."
          }
        }
      },
      "deliveryStatus": {
        "type": "string",
        "description": "Delivery status.",
        "enum": [
          "Sent",
          "Delivered",
          "Read",
          "Not Delivered"
        ]
      },
      "deliveryStatusErrorMessage": {
        "type": "string",
        "description": "User-facing error text for Not Delivered."
      },
      "attachments": {
        "type": "array",
        "description": "Attachments; each url must stay valid at least 20 minutes.",
        "items": {
          "type": "object",
          "properties": {
            "filename": {
              "type": "string",
              "description": "File name, e.g. house.jpg."
            },
            "url": {
              "type": "string",
              "description": "Attachment URL."
            }
          }
        }
      },
      "richObjects": {
        "type": "array",
        "description": "Rich Object URLs.",
        "items": {
          "type": "string"
        }
      }
    },
    "required": [
      "inboxAppId",
      "externalConversationId",
      "externalMessageId",
      "message",
      "isIncoming",
      "sender"
    ]
  }
},
{
  "name": "inboxAppUpdateMessage",
  "description": "Update the delivery status of an inbox app message. Identify the message by id or externalMessageId. Message text cannot be changed here.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "inboxAppId": {
        "type": "string",
        "description": "ID of the inbox app making the call."
      },
      "id": {
        "type": "integer",
        "description": "FUB ID of the inbox app message."
      },
      "externalMessageId": {
        "type": "string",
        "description": "Your ID for the message; alone it identifies the message."
      },
      "deliveryStatus": {
        "type": "string",
        "description": "Delivery status.",
        "enum": [
          "Sent",
          "Delivered",
          "Read",
          "Not Delivered"
        ]
      },
      "deliveryStatusErrorMessage": {
        "type": "string",
        "description": "User-facing error text for Not Delivered."
      }
    },
    "required": [
      "inboxAppId"
    ]
  }
},
{
  "name": "inboxAppAddNote",
  "description": "Add an internal note to an inbox app conversation, keyed by your externalConversationId.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "inboxAppId": {
        "type": "string",
        "description": "ID of the inbox app making the call."
      },
      "externalConversationId": {
        "type": "string",
        "description": "Your ID of the conversation to add the note to."
      },
      "body": {
        "type": "string",
        "description": "Plain-text body of the note."
      },
      "user": {
        "type": "object",
        "description": "User adding the note. Set id OR name/email.",
        "properties": {
          "id": {
            "type": "string",
            "description": "User ID adding the note."
          },
          "name": {
            "type": "string",
            "description": "User name if no ID."
          },
          "email": {
            "type": "string",
            "description": "User email if no ID."
          }
        }
      }
    },
    "required": [
      "inboxAppId",
      "externalConversationId",
      "body",
      "user"
    ]
  }
},
{
  "name": "inboxAppUpdateConversation",
  "description": "Update an inbox app conversation: subject, archive state, person, or assignment. Send only fields to change.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "inboxAppId": {
        "type": "string",
        "description": "ID of the inbox app making the call."
      },
      "extConversationId": {
        "type": "string",
        "description": "Your external ID of the conversation to update."
      },
      "subject": {
        "type": "string",
        "description": "Sets or updates the conversation subject."
      },
      "archived": {
        "type": "boolean",
        "description": "Archive or unarchive the conversation."
      },
      "permanentlyArchived": {
        "type": "boolean",
        "description": "Disables replies/notes; users cannot un-archive."
      },
      "person": {
        "type": "object",
        "description": "Updates the person; only allowed if no Person ID is set yet.",
        "properties": {
          "id": {
            "type": "integer",
            "description": "FUB Person ID."
          },
          "name": {
            "type": "string",
            "description": "Name, for people not yet in FUB."
          },
          "email": {
            "type": "string",
            "description": "Email, for people not yet in FUB."
          },
          "phone": {
            "type": "string",
            "description": "Phone, for people not yet in FUB."
          }
        }
      },
      "assignedUserId": {
        "type": "integer",
        "description": "User to reassign to. 0 reverts to the conversation owner."
      },
      "assignedInboxId": {
        "type": "integer",
        "description": "Team Inbox to reassign to. 0 reverts to the conversation owner."
      }
    },
    "required": [
      "inboxAppId",
      "extConversationId"
    ]
  }
},
{
  "name": "inboxAppGetParticipants",
  "description": "List participants of an inbox app conversation.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "inboxAppId": {
        "type": "string",
        "description": "ID of the inbox app making the call."
      },
      "extConversationId": {
        "type": "string",
        "description": "Your external ID of the conversation."
      }
    },
    "required": [
      "inboxAppId",
      "extConversationId"
    ]
  }
},
{
  "name": "inboxAppCreateParticipant",
  "description": "Add a participant to an inbox app conversation. Give exactly one of personId, userId, relationshipId, or name/email/phone.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "inboxAppId": {
        "type": "string",
        "description": "ID of the inbox app making the call."
      },
      "extConversationId": {
        "type": "string",
        "description": "Your external ID of the conversation."
      },
      "personId": {
        "type": "integer",
        "description": "FUB Person ID. Mutually exclusive with the other ID fields."
      },
      "userId": {
        "type": "integer",
        "description": "FUB User ID. Mutually exclusive with the other ID fields."
      },
      "relationshipId": {
        "type": "integer",
        "description": "FUB Relationship ID. Mutually exclusive with the other ID fields."
      },
      "name": {
        "type": "string",
        "description": "Name, if no ID is known."
      },
      "email": {
        "type": "string",
        "description": "Email, if no ID is known."
      },
      "phone": {
        "type": "string",
        "description": "Phone, if no ID is known."
      },
      "isAutomation": {
        "type": "boolean",
        "description": "True if the participant is an automated system. Default false."
      }
    },
    "required": [
      "inboxAppId",
      "extConversationId"
    ]
  }
},
{
  "name": "inboxAppDeleteParticipant",
  "description": "Remove a participant from an inbox app conversation.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "inboxAppId": {
        "type": "string",
        "description": "ID of the inbox app making the call."
      },
      "extConversationId": {
        "type": "string",
        "description": "Your external ID of the conversation."
      },
      "participantId": {
        "type": "string",
        "description": "ID of the participant to remove."
      }
    },
    "required": [
      "inboxAppId",
      "extConversationId",
      "participantId"
    ]
  }
},
{
  "name": "inboxAppInstall",
  "description": "Install an inbox app for a user or account-wide. Needs the publishedInboxAppId from FUB's app catalog and a webhook subscriptionUrl for replies.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "publishedInboxAppId": {
        "type": "integer",
        "description": "Your Published Inbox App ID."
      },
      "userId": {
        "type": "integer",
        "description": "User ID to scope the app to, or 0 for account-wide."
      },
      "subscriptionUrl": {
        "type": "string",
        "description": "Webhook URL that receives inbox app replies."
      }
    },
    "required": [
      "publishedInboxAppId",
      "userId",
      "subscriptionUrl"
    ]
  }
},
{
  "name": "inboxAppDeactivate",
  "description": "Deactivate an inbox app installation by ID. Destructive.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Inbox app ID to deactivate (DELETE /inboxApps/{id})."
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "listInboxAppInstallations",
  "description": "List installations of one published inbox app. Needs a registered third-party system (FUB_SYSTEM and FUB_SYSTEM_KEY).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Results per call, max 100. Server sends 100 when omitted (FUB's own default is 10)."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip before returning results."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next of the previous call for the next page."
      },
      "publishedInboxAppId": {
        "type": "string",
        "description": "Published Inbox App ID whose installations to list."
      }
    },
    "required": [
      "publishedInboxAppId"
    ]
  }
},

// ==================== REACTIONS ====================
{
  "name": "getReactions",
  "description": "Get ONE reaction by the reaction's own ID. To list a note's reactions, fetch the note with includeReactions=true instead.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Reaction ID."
      }
    },
    "required": [
      "id"
    ]
  }
},
{
  "name": "createReaction",
  "description": "Add an emoji reaction to a Note, Call or ThreadedReply as the API key owner. Beta endpoint.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "refType": {
        "type": "string",
        "description": "Type of item reacted to.",
        "enum": [
          "Note",
          "Call",
          "ThreadedReply"
        ]
      },
      "refId": {
        "type": "integer",
        "description": "ID of the item being reacted to."
      },
      "body": {
        "type": "string",
        "description": "Single-character emoji, e.g. a thumbs up."
      }
    },
    "required": [
      "refType",
      "refId"
    ]
  }
},
{
  "name": "deleteReaction",
  "description": "Delete the API key owner's reaction from a Note, Call or ThreadedReply. Pass emoji to remove a specific one.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "refType": {
        "type": "string",
        "description": "Type of item reacted to.",
        "enum": [
          "Note",
          "Call",
          "ThreadedReply"
        ]
      },
      "refId": {
        "type": "string",
        "description": "ID of the item the reaction is on."
      },
      "emoji": {
        "type": "string",
        "description": "Single-character emoji reaction to delete."
      }
    },
    "required": [
      "refType",
      "refId"
    ]
  }
},

// ==================== THREADED REPLIES ====================
{
  "name": "getThreadedReplies",
  "description": "Get ONE threaded reply by the reply's own ID. To list a note's replies, fetch the note with includeThreadedReplies=true instead.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Reply ID."
      }
    },
    "required": [
      "id"
    ]
  }
}

,

// ==================== CONVENIENCE TOOLS ====================
{
  "name": "removeTagFromPerson",
  "description": "Remove one tag from a person, leaving other tags untouched (case-insensitive). Use this instead of updatePerson tags, which replaces ALL tags.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "description": "Person ID."
      },
      "tag": {
        "type": "string",
        "description": "Tag to remove (case-insensitive)."
      }
    },
    "required": [
      "id",
      "tag"
    ]
  }
},
{
  "name": "getPersonByEmail",
  "description": "Look up one person by email. Returns the contact, or an ambiguity result with candidate IDs. Use this to find a contact; use listPeople for other filters.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "email": {
        "type": "string",
        "description": "Email address to look up."
      }
    },
    "required": [
      "email"
    ]
  }
},
{
  "name": "searchPeopleByTag",
  "description": "Find people with a tag (GET /people?tags=). Use this for a simple tag lookup; use listPeople when combining tags with other filters. OR-matching of multiple tags is unverified.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tags": {
        "type": "string",
        "description": "Comma-separated tags, e.g. 'Investor,Buyer'."
      },
      "limit": {
        "type": "integer",
        "description": "Max results, up to 100. Server sets no default; FUB default is 10."
      },
      "offset": {
        "type": "integer",
        "description": "Rows to skip."
      },
      "next": {
        "type": "string",
        "description": "Cursor from _metadata.next."
      },
      "sort": {
        "type": "string",
        "description": "Sort field; prefix with - for descending."
      },
      "fields": {
        "type": "string",
        "description": "Comma-separated fields to return."
      }
    },
    "required": [
      "tags"
    ]
  }
},
{
  "name": "bulkUpdatePeople",
  "description": "Apply the same updatePerson changes to many people, throttled (pauses 11s per 20 people). Use this instead of looping updatePerson. Returns per-person success.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "ids": {
        "type": "array",
        "description": "Person IDs to update.",
        "items": {
          "type": "integer"
        }
      },
      "mergeTags": {
        "type": "boolean",
        "description": "Merge tags instead of replacing them."
      },
      "updates": {
        "type": "object",
        "description": "Fields to set on each person, same as updatePerson (tags, stage, assignedUserId, custom fields)."
      }
    },
    "required": [
      "ids",
      "updates"
    ]
  }
},
{
  "name": "listAvailableTags",
  "description": "List distinct tags by scanning recent contacts (up to 500, 100 per page). Rarely used tags may be missed. Use searchPeopleByTag to find people with a known tag.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Contacts to scan, max 500. Default 500."
      }
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
  // Safe Mode enforcement lives HERE, at the single built-in dispatch choke point,
  // so it protects every caller — including overlays and forks that import
  // handleToolCall directly and never pass through createServer's request handler.
  if (FUB_SAFE_MODE && isDeleteTool(name)) {
    throw new Error('This tool is disabled in Safe Mode. To enable delete operations, set FUB_SAFE_MODE=false.');
  }
  const args = stripMetaParams(rawArgs);
  try {
    switch (name) {

    // ==================== META (about + help) ====================
    case 'about': {
      return {
        server: 'Follow Up Boss MCP Server',
        version: VERSION,
        author: {
          name: 'Ed Neuhaus',
          title: 'Broker / Owner',
          company: 'Neuhaus Realty Group, LLC',
          location: 'Austin, Texas',
          experience: '19+ years in real estate (since 2007)',
          contact: 'https://neuhausre.com/contact/',
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
          'Got a real estate client moving to or from Austin? Refer them. Texas real estate referrals welcome from licensed agents in any state. Reach out via https://neuhausre.com/contact/.',
          'Write about this tool on your blog, LinkedIn, or X. Tag @edneuhaus and link to neuhausre.com.',
          'Open an issue or PR on GitHub if you find a bug or build something useful.'
        ],
        contributors: {
          'yoship90': 'Smart list API key fix (v1.1.2)',
          'chad778': 'OAuth + remote transport prototype (in fork chad778/followupboss-mcp-server)',
          'joefeser': 'Safe Mode, MCP error, and duplicate-email fixes; dependency security updates (v1.5.3)'
        },
        license: 'Elastic License 2.0 — see LICENSE file. Self-host free; commercial hosting/resale requires separate agreement.',
        github: 'https://github.com/mindwear-capitian/followupboss-mcp-server'
      };
    }
    case 'help': {
      return {
        server: `Follow Up Boss MCP Server v${VERSION}`,
        getting_started: 'Set FUB_API_KEY in your MCP host config (Claude Desktop, Claude Code, Cline, Cursor, etc.). Run `npm run setup` for an interactive wizard.',
        common_examples: [
          '"Show me my smart lists" → listSmartLists ({all: true} to include modern UI lists)',
          '"Find duplicates of John Smith" → checkDuplicate',
          '"Create a deal for the Anderson contact" → createDeal',
          '"List my open tasks for today" → listTasks',
          '"Tag this contact as Hot Lead" → updatePerson + tag mgmt'
        ],
        input_rules: [
          'Paging: list tools return a _metadata block. If _metadata.next is set, there are more rows. Call the same tool again with next=<that value>.',
          'Page size: limit is max 100. listPeople defaults to 10; most no-filter list tools (listStages, listPipelines, listPonds, ...) default to 100.',
          'Sorting: sort takes a field name; prefix with - for descending (e.g. -lastActivity). FUB silently ignores an unknown name, so check the tool description for valid values.',
          'Stages: listPeople stage filter takes the stage NAME (e.g. "Lead"); listDeals stageId takes the numeric ID. Get both from listStages.',
          'Fields: pass fields=id,name,... to keep responses small; fields=allFields returns everything.'
        ],
        safe_mode: 'FUB_SAFE_MODE=true (default) disables all 24 DELETE-backed tools. Create, update, and bulk-update tools remain enabled. Set to false only if you really need delete operations.',
        bug_reports: 'https://github.com/mindwear-capitian/followupboss-mcp-server/issues',
        feature_requests: 'PRs welcome. Or open an issue.',
        author: 'Ed Neuhaus, broker @ Neuhaus Realty Group, Austin TX. Contact: https://neuhausre.com/contact/. Real estate referrals from licensed agents in any state are welcome.',
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
      const response = await fubApi.get('/people', { params: { sort: '-created', ...args } });
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
      requireSystemCreds('updatePersonAttachment');
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
      return { calls: (response.data.calls || []).map(redactRecordingUrl), _metadata: response.data._metadata };
    }
    case 'createCall': {
      const body = translateCallArgs(args);
      const response = await fubApi.post('/calls', body);
      return redactRecordingUrl(response.data);
    }
    case 'getCall': {
      const response = await fubApi.get(`/calls/${args.id}`);
      return redactRecordingUrl(response.data);
    }
    case 'updateCall': {
      const { id, ...rest } = args;
      const body = translateCallArgs(rest);
      const response = await fubApi.put(`/calls/${id}`, body);
      return redactRecordingUrl(response.data);
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
      // FUB rejects the update unless subject and body are both present: keep the current ones.
      if (body.subject === undefined || body.body === undefined) {
        const cur = (await fubApi.get(`/templates/${id}`)).data || {};
        if (body.subject === undefined) body.subject = cur.subject;
        if (body.body === undefined) body.body = cur.body;
      }
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
      // FUB rejects the update unless message is present: keep the current one.
      if (body.message === undefined) {
        const cur = (await fubApi.get(`/textMessageTemplates/${id}`)).data || {};
        body.message = cur.message;
      }
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
      const response = await fubApi.get('/customFields', { params: args });
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
      const response = await fubApi.get('/stages', { params: { limit: 100, ...args } });
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
      await fubApi.delete(`/stages/${args.id}`, { params: { assignStageId: args.assignStageId } });
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
      const { sendInvitation, ...apptArgs } = args;
      const body = translateAppointmentArgs(apptArgs);
      const response = await fubApi.post('/appointments', body, sendInvitation === undefined ? undefined : { params: { sendInvitation } });
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
      const response = await fubApi.get('/appointmentTypes', { params: { limit: 100, ...args } });
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
      await fubApi.delete(`/appointmentTypes/${args.id}`, { params: { assignTypeId: args.assignTypeId } });
      return { success: true, message: `Appointment type ${args.id} deleted` };
    }

    // ==================== APPOINTMENT OUTCOMES ====================
    case 'listAppointmentOutcomes': {
      const response = await fubApi.get('/appointmentOutcomes', { params: { limit: 100, ...args } });
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
      await fubApi.delete(`/appointmentOutcomes/${args.id}`, { params: { assignOutcomeId: args.assignOutcomeId } });
      return { success: true, message: `Appointment outcome ${args.id} deleted` };
    }

    // ==================== WEBHOOKS ====================
    case 'listWebhooks': {
      requireWebhookCreds();
      const response = await fubApi.get('/webhooks', { params: { limit: 100, ...args } });
      return { webhooks: response.data.webhooks, _metadata: response.data._metadata };
    }
    case 'createWebhook': {
      requireWebhookCreds();
      const response = await fubApi.post('/webhooks', args);
      return response.data;
    }
    case 'getWebhook': {
      requireWebhookCreds();
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
      requireWebhookCreds();
      const response = await fubApi.get(`/webhookEvents/${args.id}`);
      return response.data;
    }

    // ==================== PIPELINES ====================
    case 'listPipelines': {
      const response = await fubApi.get('/pipelines', { params: { limit: 100, ...args } });
      return { pipelines: response.data.pipelines, _metadata: response.data._metadata };
    }
    case 'createPipeline': {
      // FUB answers 500, and still makes the pipeline without stages, when a stage has no closedStage.
      const body = Array.isArray(args.stages)
        ? { ...args, stages: args.stages.map(st => (st && typeof st === 'object' && st.closedStage === undefined ? { ...st, closedStage: false } : st)) }
        : args;
      const response = await fubApi.post('/pipelines', body);
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
      const response = await fubApi.get('/dealCustomFields', { params: args });
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
      const response = await fubApi.get('/groups', { params: { limit: 100, ...args } });
      return { groups: response.data.groups, _metadata: response.data._metadata };
    }
    case 'listRoundRobinGroups': {
      const response = await fubApi.get('/groups/roundRobin', { params: args });
      return { groups: response.data.groups, _metadata: response.data._metadata };
    }
    case 'createGroup': {
      const { userIds, ...rest } = args;
      const body = rest.users === undefined && userIds !== undefined ? { ...rest, users: userIds } : rest;
      const response = await fubApi.post('/groups', body);
      return response.data;
    }
    case 'getGroup': {
      const response = await fubApi.get(`/groups/${args.id}`);
      return response.data;
    }
    case 'updateGroup': {
      const { id, userIds, ...rest } = args;
      const body = rest.users === undefined && userIds !== undefined ? { ...rest, users: userIds } : rest;
      // FUB rejects the update unless users is present: keep the current members.
      if (body.users === undefined) {
        const cur = (await fubApi.get(`/groups/${id}`)).data || {};
        body.users = (cur.users || []).map(u => (u && typeof u === 'object' ? u.id : u)).filter(v => v !== undefined);
      }
      const response = await fubApi.put(`/groups/${id}`, body);
      return response.data;
    }
    case 'deleteGroup': {
      await fubApi.delete(`/groups/${args.id}`);
      return { success: true, message: `Group ${args.id} deleted` };
    }

    // ==================== TEAMS ====================
    case 'listTeams': {
      const response = await fubApi.get('/teams', { params: { limit: 100, ...args } });
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
      const response = await fubApi.get('/teamInboxes', { params: { limit: 100, ...args } });
      return { teamInboxes: response.data.teamInboxes || response.data.teaminboxes, _metadata: response.data._metadata };
    }

    // ==================== PONDS ====================
    case 'listPonds': {
      const response = await fubApi.get('/ponds', { params: { limit: 100, ...args } });
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
      await fubApi.delete(`/ponds/${args.id}`, { params: { assignTo: args.assignTo } });
      return { success: true, message: `Pond ${args.id} deleted` };
    }

    // ==================== TIMEFRAMES ====================
    case 'listTimeframes': {
      const response = await fubApi.get('/timeframes', { params: { limit: 100, ...args } });
      return { timeframes: response.data.timeframes, _metadata: response.data._metadata };
    }

    // ==================== INBOX APPS ====================
    // FUB inbox app endpoints — corrected paths per docs.followupboss.com/reference.
    // Old "/inboxApps/addMessage" style was wrong (no such collection); FUB uses
    // /inboxApps/messages, /inboxApps/notes, /inboxApps/conversations/:id, etc.
    case 'inboxAppAddMessage': {
      const { inboxAppId, ...body } = args;
      const response = await fubApi.post(`/inboxApps/${inboxAppId}/message`, body);
      return response.data;
    }
    case 'inboxAppUpdateMessage': {
      const { inboxAppId, messageId, ...body } = args;
      if (body.id === undefined && messageId !== undefined) body.id = messageId;
      const response = await fubApi.put(`/inboxApps/${inboxAppId}/message`, body);
      return response.data;
    }
    case 'inboxAppAddNote': {
      const { inboxAppId, ...body } = args;
      const response = await fubApi.post(`/inboxApps/${inboxAppId}/note`, body);
      return response.data;
    }
    case 'inboxAppUpdateConversation': {
      const { inboxAppId, extConversationId, ...body } = args;
      const response = await fubApi.put(`/inboxApps/${inboxAppId}/conversations/${encodeURIComponent(extConversationId)}`, body);
      return response.data;
    }
    case 'inboxAppGetParticipants': {
      const { inboxAppId, extConversationId } = args;
      const response = await fubApi.get(`/inboxApps/${inboxAppId}/conversations/${encodeURIComponent(extConversationId)}/participants`);
      return response.data;
    }
    case 'inboxAppCreateParticipant': {
      const { inboxAppId, extConversationId, ...body } = args;
      const response = await fubApi.post(`/inboxApps/${inboxAppId}/conversations/${encodeURIComponent(extConversationId)}/participants`, body);
      return response.data;
    }
    case 'inboxAppDeleteParticipant': {
      const { inboxAppId, extConversationId, participantId, id } = args;
      const pid = participantId || id;
      await fubApi.delete(`/inboxApps/${inboxAppId}/conversations/${encodeURIComponent(extConversationId)}/participants/${pid}`);
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
      const { publishedInboxAppId, ...params } = args;
      const response = await fubApi.get(`/inboxApps/installedApps/${publishedInboxAppId}`, { params });
      return response.data;
    }

    // ==================== REACTIONS ====================
    case 'getReactions': {
      const response = await fubApi.get(`/reactions/${args.id}`);
      return response.data;
    }
    case 'createReaction': {
      const { refType, refId, emoji, ...body } = args;
      if (body.body === undefined && emoji !== undefined) body.body = emoji;
      const response = await fubApi.post(`/reactions/${refType}/${refId}`, body);
      return response.data;
    }
    case 'deleteReaction': {
      const { refType, refId, emoji } = args;
      await fubApi.delete(`/reactions/${refType}/${refId}`, emoji ? { params: { emoji } } : undefined);
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
      // Fetch two rows so a full page proves ambiguity without downloading every
      // duplicate. FUB's collection metadata supplies the complete match count.
      const response = await fubApiWithRetry('get', '/people', { params: { email: args.email, limit: 2 } });
      const people = response.data.people || [];
      const metadataTotal = Number(response.data._metadata?.total);
      const hasTotal = Number.isFinite(metadataTotal);
      if ((hasTotal && metadataTotal > 1) || people.length > 1) {
        const matchCount = hasTotal ? metadataTotal : people.length;
        const candidates = people.map(person => ({
          id: person.id,
          ...(person.name ? { name: person.name } : {})
        }));
        return {
          found: false,
          ambiguous: true,
          message: `Multiple people found with email ${args.email}; choose a person ID before continuing`,
          matchCount,
          candidates
        };
      }
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
      return markToolError({ error: `Unknown tool: ${name}` });
    }
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

// Single source of truth for "is this a destructive delete tool?" — used both to
// filter the advertised tool surface and to enforce Safe Mode at dispatch time.
// Server instructions: sent once at connect. Tells the AI the one-call answer to common questions.
export const DEFAULT_INSTRUCTIONS = `Follow Up Boss CRM tools. Answer common questions in ONE call:
- New leads: listPeople stage="Lead" (newest created first by default). For "today" or "this week", read each person's created date and stop at the first one older than the start date.
- Find a contact: getPersonByEmail for an email; listPeople name="First Last" or phone= otherwise.
- Tasks: listTasks isCompleted=false with due="today" or due="overdue"; add assignedUserId for one agent, personId for one contact. Get your own user ID from getCurrentUser.
- Appointments: listAppointments start=<ISO> end=<ISO>; add userId or personId to narrow.
- Deals: listDeals with pipelineId, stageId, userId or personId. Stage and pipeline IDs come from listStages and listPipelines.
- Notes: createNote personId + body. Tasks: createTask personId + name + dueDate (YYYY-MM-DD) + assignedUserId.
Rules:
- Stage filters on listPeople take the stage NAME; listStages gives this account's names.
- updatePerson tags REPLACES all tags unless mergeTags=true. To remove one tag use removeTagFromPerson.
- Lists return 10 rows unless limit is set (max 100). If _metadata.next is set, call again with next=<value>.
- Pass fields=id,name,stage,created,... to keep responses small.`;

export function isDeleteTool(name) {
  const n = String(name).toLowerCase();
  return n.startsWith('delete')
    || name === 'inboxAppDeleteParticipant'
    || name === 'inboxAppDeactivate';
}

// ---------------------------------------------------------------------------
// Tool groups (FUB_TOOL_GROUPS), annotations, always-load hints.
// FUB_TOOL_GROUPS: comma list of core,setup,marketing,integrations,delete or "all" (default).
// The tool list is a server setting: the same for every caller of this server.
// ---------------------------------------------------------------------------
const CORE_TOOLS = new Set([
  'listPeople', 'getPerson', 'createPerson', 'updatePerson', 'getPersonByEmail',
  'listNotes', 'createNote', 'listTasks', 'createTask', 'updateTask',
  'listAppointments', 'createAppointment', 'updateAppointment',
  'listCalls', 'listTextMessages', 'listDeals', 'getDeal', 'createDeal', 'updateDeal',
  'listSmartLists', 'listStages', 'removeTagFromPerson', 'help'
]);
const MARKETING_PREFIX = /^(list|get|create|update|delete|merge)?(Template|TextMessageTemplate|EmCampaign|EmEvent|ActionPlan|Automation)/;
const INTEGRATION_PREFIX = /^(list|get|create|update|delete)?(Webhook|Event|PersonAttachment|DealAttachment|Reaction|ThreadedReplies|InboxApp)|^inboxApp/;

export function toolGroup(name) {
  if (isDeleteTool(name)) return 'delete';
  if (CORE_TOOLS.has(name)) return 'core';
  if (MARKETING_PREFIX.test(name) || /^(add|update)PersonToActionPlan|^addPersonToAutomation|ActionPlan|Automation/.test(name)) return 'marketing';
  if (INTEGRATION_PREFIX.test(name) || /Webhook|Reaction|ThreadedRepl|Attachment|^inboxApp|^listInboxApp|^(create|list|get)Event/.test(name)) return 'integrations';
  return 'setup';
}

const FUB_TOOL_GROUPS = (() => {
  const raw = (process.env.FUB_TOOL_GROUPS || 'all').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  return raw.includes('all') ? null : new Set(raw);
})();

// MCP tool annotations. Claude uses them for permissions (read-only tools can run
// without approval; destructive tools always ask). ChatGPT requires them.
export function toolAnnotations(name) {
  const n = String(name);
  const readOnly = /^(list|get|search|check|help|about|merge)/.test(n);
  const del = isDeleteTool(n) || n === 'removeTagFromPerson';
  const send = /^send/.test(n);
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && (del || /^(update|bulkUpdate)/.test(n)),
    idempotentHint: readOnly || del || /^update/.test(n),
    openWorldHint: send
  };
}

// Tools Claude Code loads up front instead of behind tool search.
const ALWAYS_LOAD = new Set((process.env.FUB_ALWAYS_LOAD ||
  'listPeople,getPerson,getPersonByEmail,listTasks,createTask,createNote,listAppointments')
  .split(',').map(x => x.trim()).filter(Boolean));

export function decorateTool(t) {
  const out = { ...t, annotations: { ...toolAnnotations(t.name), ...(t.annotations || {}) } };
  if (ALWAYS_LOAD.has(t.name)) out._meta = { ...(t._meta || {}), 'anthropic/alwaysLoad': true };
  return out;
}

export const activeTools = TOOL_DEFINITIONS
  .filter(t => !(FUB_SAFE_MODE && isDeleteTool(t.name)))
  .filter(t => !FUB_TOOL_GROUPS || FUB_TOOL_GROUPS.has(toolGroup(t.name)))
  .map(decorateTool);

/**
 * Create an MCP Server with the FUB tool surface.
 *
 * @param {object} [opts]
 * @param {Array} [opts.extraTools] - Additional tool definitions to merge with the
 *   built-in TOOL_DEFINITIONS. Used by projects that layer custom tools
 *   (e.g., extra custom tools) on top of the public API-key tool surface.
 * @param {Function} [opts.extraHandler] - async (name, args) => result. Called for
 *   any tool name not in the built-in handler. Throw to propagate as error.
 * @param {object} [opts.serverInfo] - Override name/version/description in the MCP
 *   server handshake. Useful for extensions that want to identify themselves.
 */
export function createServer(opts = {}) {
  const { extraTools = [], extraHandler = null, serverInfo = {}, instructions = '' } = opts;

  const server = new Server(
    {
      name: serverInfo.name || 'followupboss-mcp-server',
      version: serverInfo.version || VERSION,
      description: serverInfo.description || 'Follow Up Boss MCP server by Ed Neuhaus, real estate broker @ Neuhaus Realty Group (neuhausre.com). Call the `about` tool for more, or `help` for usage tips.'
    },
    {
      capabilities: { tools: {} },
      instructions: [DEFAULT_INSTRUCTIONS, instructions].filter(Boolean).join('\n\n'),
      // 2026-07-28 cache hints for list results. The tool list only changes on a redeploy.
      cacheHints: {
        'tools/list': { ttlMs: 5 * 60 * 1000, cacheScope: 'public' },
        'server/discover': { ttlMs: 5 * 60 * 1000, cacheScope: 'public' }
      }
    }
  );

  // Active built-in tools (filtered for SAFE MODE) + any caller-supplied extras.
  // Extras are NOT auto-filtered by SAFE MODE -- caller decides per-tool.
  // Extras replace a built-in tool with the same name (calls already route to the extra handler).
  const extraToolNames = new Set(extraTools.map(t => t.name));
  const extendedTools = [...activeTools.filter(t => !extraToolNames.has(t.name)), ...extraTools.map(decorateTool)];

  server.setRequestHandler('tools/list', async () => ({
    tools: extendedTools
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    // Defense-in-depth: also block here before dispatch. handleToolCall enforces
    // the same rule for built-ins; this additionally guards the extraHandler path
    // and returns a clean structured error without invoking the dispatcher.
    if (FUB_SAFE_MODE && isDeleteTool(name)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'This tool is disabled in Safe Mode. To enable delete operations, set FUB_SAFE_MODE=false.' }, null, 2) }],
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
        ...(isToolError(result) ? { isError: true } : {}),
      };
    } catch (error) {
      const payload = handleApiError(error);
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
  // serveStdio answers both 2025-era (initialize) and 2026-07-28 clients.
  await serveStdio(() => createServer(opts));
  console.error(`Follow Up Boss MCP Server v${VERSION} started via stdio (${activeTools.length} tools${FUB_SAFE_MODE ? ', SAFE MODE — delete tools disabled' : ''})`);
  console.error(`Built by Ed Neuhaus, broker @ Neuhaus Realty Group, Austin TX — https://neuhausre.com`);
  console.error(`Call the 'about' tool for full bio. Call 'help' for usage tips.`);
}

export async function startHttp(opts = {}) {
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const BEARER = process.env.MCP_BEARER_TOKEN;
  const AUTH_PASSWORD = process.env.MCP_AUTH_PASSWORD;
  const AUTH_DISABLED = process.env.MCP_AUTH_DISABLED === 'true' || (!BEARER && !AUTH_PASSWORD);
  const OAUTH_ENABLED = !!AUTH_PASSWORD && !AUTH_DISABLED;
  const LEGACY_MODE = process.env.MCP_LEGACY === 'reject' ? 'reject' : 'stateless';
  const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const MIN_PASSWORD_LENGTH = 12;

  // Internet-facing installs (the Docker image sets MCP_REQUIRE_AUTH=true)
  // must never start open or behind a guessable password.
  if (process.env.MCP_REQUIRE_AUTH === 'true') {
    if (AUTH_DISABLED) {
      console.error('ERROR: MCP_REQUIRE_AUTH=true but MCP_AUTH_PASSWORD is not set. Refusing to start.');
      process.exit(1);
    }
    if (AUTH_PASSWORD && AUTH_PASSWORD.length < MIN_PASSWORD_LENGTH) {
      console.error(`ERROR: MCP_AUTH_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters. Refusing to start.`);
      process.exit(1);
    }
  }

  if (AUTH_DISABLED) {
    console.error('WARNING: HTTP transport running without auth. Anyone who knows the URL can call the MCP.');
  } else if (OAUTH_ENABLED) {
    console.error('HTTP transport running with OAuth 2.1 (DCR + PKCE + password gate).');
  } else {
    console.error('HTTP transport running with static bearer token.');
  }

  const app = express();
  // Behind a reverse proxy (Caddy in deploy/hostinger), req.ip is the proxy
  // unless Express trusts the forwarded client address. Set to the hop count.
  if (process.env.MCP_TRUST_PROXY) app.set('trust proxy', parseInt(process.env.MCP_TRUST_PROXY, 10) || 1);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));

  // OAuth clients + access tokens persist to disk so a server restart
  // (redeploy, crash, host reboot) does not force every connected client to
  // re-authenticate. authCodes stay in-memory -- 5-min TTL, losing one
  // mid-flight just means retry the login, not worth the disk writes.
  const OAUTH_STORE_PATH = process.env.MCP_OAUTH_STORE_PATH || resolve(__dirname, 'data/oauth-store.json');

  function loadOAuthStore() {
    try {
      if (!existsSync(OAUTH_STORE_PATH)) return { clients: {}, accessTokens: {} };
      const data = JSON.parse(readFileSync(OAUTH_STORE_PATH, 'utf8'));
      return { clients: data.clients || {}, accessTokens: data.accessTokens || {} };
    } catch (e) {
      console.error(`OAuth store at ${OAUTH_STORE_PATH} unreadable, starting empty:`, e.message);
      return { clients: {}, accessTokens: {} };
    }
  }

  function saveOAuthStore() {
    try {
      mkdirSync(dirname(OAUTH_STORE_PATH), { recursive: true });
      const tmpPath = `${OAUTH_STORE_PATH}.tmp`;
      writeFileSync(tmpPath, JSON.stringify({
        clients: Object.fromEntries(clients),
        accessTokens: Object.fromEntries(accessTokens)
      }));
      renameSync(tmpPath, OAUTH_STORE_PATH);
    } catch (e) {
      console.error(`OAuth store save to ${OAUTH_STORE_PATH} failed:`, e.message);
    }
  }

  const oauthStore = loadOAuthStore();
  const clients = new Map(Object.entries(oauthStore.clients));       // client_id -> { redirect_uris, created_at }
  const authCodes = new Map();     // code -> { client_id, redirect_uri, code_challenge, expires_at } (in-memory, short TTL)
  const accessTokens = new Map(Object.entries(oauthStore.accessTokens));  // token -> { client_id, expires_at }

  // Periodic cleanup of expired state.
  setInterval(() => {
    const now = Date.now();
    let accessTokensChanged = false;
    for (const [k, v] of authCodes) if (v.expires_at < now) authCodes.delete(k);
    for (const [k, v] of accessTokens) if (v.expires_at < now) { accessTokens.delete(k); accessTokensChanged = true; }
    if (accessTokensChanged) saveOAuthStore();
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
    // Hash both sides first so the compare takes the same time whatever the length.
    const ah = createHash('sha256').update(String(a)).digest();
    const bh = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(ah, bh);
  }

  // Wrong-password lockout for POST /oauth/authorize. Per client IP, plus a
  // looser server-wide cap so a flood from many IPs still stalls. In memory:
  // a restart clears it, which is fine for a lockout this short.
  const AUTH_MAX_FAILS = parseInt(process.env.MCP_AUTH_MAX_FAILS || '5', 10);
  const AUTH_GLOBAL_MAX_FAILS = parseInt(process.env.MCP_AUTH_GLOBAL_MAX_FAILS || '50', 10);
  const AUTH_LOCK_MS = parseInt(process.env.MCP_AUTH_LOCK_MINUTES || '15', 10) * 60 * 1000;
  const authFails = new Map(); // ip (or '*' for all) -> timestamps of recent wrong passwords
  const recentAuthFails = (key) => {
    const cutoff = Date.now() - AUTH_LOCK_MS;
    const list = (authFails.get(key) || []).filter(t => t > cutoff);
    if (list.length) authFails.set(key, list); else authFails.delete(key);
    return list;
  };
  const lockKey = (ip) => {
    const a = String(ip || '');
    const v4 = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4) return v4[1];
    if (!a.includes(':')) return a;
    // Expand :: and keep the first 4 groups (the /64 network).
    const [head, tail = ''] = a.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    return groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
  };
  const authLocked = (ip) =>
    recentAuthFails(lockKey(ip)).length >= AUTH_MAX_FAILS || recentAuthFails('*').length >= AUTH_GLOBAL_MAX_FAILS;
  const recordAuthFail = (ip) => {
    const now = Date.now();
    for (const key of [lockKey(ip), '*']) authFails.set(key, [...recentAuthFails(key), now]);
  };
  setInterval(() => { for (const k of [...authFails.keys()]) recentAuthFails(k); }, 60 * 1000).unref();

  // Caddy on-demand TLS "ask" check (MCP_CADDY_ASK=true, set by deploy/hostinger).
  // Allows a certificate only for this server's Hostinger name or DOMAIN, and only
  // after a request to that name on port 80 reaches this same process.
  if (process.env.MCP_CADDY_ASK === 'true') {
    const selfToken = randomBytes(16).toString('hex');
    const domain = (process.env.DOMAIN || '').trim().toLowerCase();
    const selfPort = process.env.MCP_SELF_CHECK_PORT || '80';
    const askCache = new Map(); // name -> { ok, until }
    app.get('/.well-known/fub-mcp-self', (_req, res) => res.type('text/plain').send(selfToken));
    app.get('/caddy-ask', async (req, res) => {
      const name = String(req.query.domain || '').toLowerCase();
      const shapeOk = /^srv[0-9]+\.hstgr\.cloud$/.test(name) || (domain && name === domain);
      if (!shapeOk) return res.sendStatus(403);
      const hit = askCache.get(name);
      if (hit && hit.until > Date.now()) return res.sendStatus(hit.ok ? 200 : 403);
      let ok = false;
      try {
        const r = await fetch(`http://${name}:${selfPort}/.well-known/fub-mcp-self`, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
        ok = r.ok && (await r.text()).trim() === selfToken;
      } catch { ok = false; }
      askCache.set(name, { ok, until: Date.now() + (ok ? 24 * 3600e3 : 10 * 60e3) });
      res.sendStatus(ok ? 200 : 403);
    });
  }

  // Health endpoint (no auth)
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: VERSION,
      tools: activeTools.length,
      safeMode: FUB_SAFE_MODE,
      authMode: AUTH_DISABLED ? 'none' : (OAUTH_ENABLED ? 'oauth2.1' : 'bearer'),
      transport: 'stateless',
      protocolEras: LEGACY_MODE === 'reject' ? ['modern'] : ['modern', 'legacy'],
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

  const MAX_CLIENTS = parseInt(process.env.MCP_OAUTH_MAX_CLIENTS || '500', 10);
  const MAX_REDIRECT_URIS = 10;
  function validRedirectUri(u) {
    if (typeof u !== 'string' || u.length > 2048) return false;
    let url;
    try { url = new URL(u); } catch { return false; }
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }
  // Where the sign-in sends the user back to, shown on the password form.
  const TRUSTED_REDIRECT_HOSTS = new Set(['claude.ai', 'claude.com', 'localhost', '127.0.0.1', '[::1]']);

  // OAuth: Dynamic Client Registration (RFC 7591). Claude registers itself
  // dynamically; we hand back a client_id with no secret (public client).
  app.post('/oauth/register', (req, res) => {
    if (!OAUTH_ENABLED) return res.status(404).json({ error: 'oauth_disabled' });
    const redirect_uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    if (!redirect_uris.length) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
    }
    if (redirect_uris.length > MAX_REDIRECT_URIS || !redirect_uris.every(validRedirectUri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs, or http on localhost (at most 10)' });
    }
    if (clients.size >= MAX_CLIENTS) {
      return res.status(429).json({ error: 'too_many_clients', error_description: 'Client limit reached. Restart the server with a new MCP_OAUTH_STORE_PATH to clear old clients.' });
    }
    const client_id = randomBytes(16).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    clients.set(client_id, { redirect_uris, created_at: now });
    saveOAuthStore();
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
    const returnHost = new URL(redirect_uri).host;
    const trusted = TRUSTED_REDIRECT_HOSTS.has(new URL(redirect_uri).hostname);

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
    <p>Sign in to give <strong>${esc(returnHost)}</strong> access to your Follow Up Boss tools.</p>
    ${trusted ? '' : `<div class="err">${esc(returnHost)} is not Claude. Type your password only if you started this connection yourself.</div>`}
    ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
    <input type="hidden" name="client_id" value="${esc(client_id)}">
    <input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}">
    <input type="hidden" name="state" value="${esc(state || '')}">
    <input type="hidden" name="code_challenge" value="${esc(code_challenge)}">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Authorize</button>
    <div class="meta">${FUB_SAFE_MODE ? 'Safe Mode is on: delete tools are blocked.' : 'Safe Mode is off: delete tools are allowed.'}</div>
  </form>
</body></html>`);
  });

  app.post('/oauth/authorize', (req, res) => {
    if (!OAUTH_ENABLED) return res.status(404).send('OAuth disabled');
    const { client_id, redirect_uri, state, code_challenge, password } = req.body;
    const client = clients.get(client_id);
    if (!client) return res.status(400).send('Invalid client_id');
    if (!client.redirect_uris.includes(redirect_uri)) return res.status(400).send('redirect_uri not registered');

    if (authLocked(req.ip)) {
      const minutes = Math.ceil(AUTH_LOCK_MS / 60000);
      res.set('Retry-After', String(minutes * 60));
      return res.status(429).send(`Too many wrong passwords. Try again in ${minutes} minutes.`);
    }

    if (!password || !constantTimeEq(password, AUTH_PASSWORD)) {
      recordAuthFail(req.ip);
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
    saveOAuthStore();
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

  // Stateless transport. Every POST gets a fresh server from createServer();
  // nothing is kept between requests, so a restart drops nothing.
  // 2026-07-28 clients send per-request _meta and are served as modern.
  // 2025-era clients (initialize) are served stateless with no session id,
  // unless MCP_LEGACY=reject turns this into a modern-only endpoint.
  const mcpHandler = createMcpHandler(() => createServer(opts), {
    legacy: LEGACY_MODE,
    onerror: (e) => console.error('MCP error:', e.message)
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (e) => console.error('MCP adapter error:', e.message)
  });

  // Origin check (spec MUST). Server-side clients send no Origin; a browser
  // Origin must be on the allowlist, else 403.
  const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || 'claude.ai,claude.com')
    .split(',').map(h => h.trim()).filter(Boolean);
  const originGuard = (req, res, next) => {
    const origin = req.headers['origin'];
    if (!origin) return next();
    try {
      if (ALLOWED_ORIGINS.includes(new URL(origin).hostname)) return next();
    } catch { /* malformed Origin falls through to 403 */ }
    res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } });
  };

  // Logs the protocol era of each request, so you can see when no 2025-era
  // client is left and MCP_LEGACY=reject is safe. MCP_LOG_ERA=false silences it.
  const logEra = (req, _res, next) => {
    if (process.env.MCP_LOG_ERA !== 'false') {
      const meta = req.body?.params?._meta;
      const modern = !!(meta && meta['io.modelcontextprotocol/protocolVersion']);
      console.error(`mcp era=${modern ? 'modern' : 'legacy'} method=${req.body?.method || '?'} ua="${req.headers['user-agent'] || ''}"`);
    }
    next();
  };

  app.post('/mcp', originGuard, requireAuth, logEra, (req, res) => nodeHandler(req, res, req.body));

  // No sessions, so no SSE stream to open and nothing to delete.
  const methodNotAllowed = (_req, res) => {
    res.set('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.listen(PORT, () => {
    console.error(`Follow Up Boss MCP Server v${VERSION} listening on :${PORT} (HTTP, ${activeTools.length} tools${FUB_SAFE_MODE ? ', SAFE MODE' : ''})`);
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
// Allows other projects to `import { createServer, startHttp } from
// 'followupboss-mcp-server'` and call them with custom overlays.
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
