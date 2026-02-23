#!/usr/bin/env node

/**
 * Follow Up Boss MCP Server
 *
 * A Model Context Protocol server that provides 152 tools
 * for interacting with the Follow Up Boss CRM API.
 *
 * https://github.com/mindwear-capitian/followupboss-mcp-server
 * Built by Ed Neuhaus / StaySTRA
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FUB_API_KEY = process.env.FUB_API_KEY;
if (!FUB_API_KEY) {
  console.error('ERROR: FUB_API_KEY environment variable is required.');
  console.error('Run "npm run setup" to configure, or set FUB_API_KEY in your environment.');
  process.exit(1);
}

const FUB_BASE_URL = 'https://api.followupboss.com/v1';

const fubApi = axios.create({
  baseURL: FUB_BASE_URL,
  auth: { username: FUB_API_KEY, password: '' },
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

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
// Tool Definitions (153 tools)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [

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
  "description": "List/search people in FUB with extensive filtering options",
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
  "description": "Attach a file to a person",
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
  "description": "Create a relationship between two people",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "First person ID" },
      "relatedPersonId": { "type": "number", "description": "Related person ID" },
      "relationshipType": { "type": "string", "description": "Type of relationship" },
      "notes": { "type": "string", "description": "Notes about the relationship" }
    },
    "required": ["personId", "relatedPersonId"]
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
  "description": "Update a relationship",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Relationship ID" },
      "relationshipType": { "type": "string", "description": "Type of relationship" },
      "notes": { "type": "string", "description": "Notes" }
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
  "description": "Log a call for a person",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "duration": { "type": "number", "description": "Call duration in seconds" },
      "direction": { "type": "string", "description": "Call direction: inbound or outbound" },
      "userId": { "type": "number", "description": "User who made the call" },
      "notes": { "type": "string", "description": "Call notes" },
      "occurredAt": { "type": "string", "description": "ISO timestamp when call occurred" }
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
      "duration": { "type": "number", "description": "Duration" },
      "direction": { "type": "string", "description": "Direction" },
      "userId": { "type": "number", "description": "User ID" },
      "notes": { "type": "string", "description": "Notes" },
      "occurredAt": { "type": "string", "description": "Timestamp" }
    },
    "required": ["id"]
  }
},

// ==================== TEXT MESSAGES ====================
{
  "name": "listTextMessages",
  "description": "List text messages",
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
  "name": "createTextMessage",
  "description": "Send a text message to a person",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "message": { "type": "string", "description": "Message text" },
      "userId": { "type": "number", "description": "Sending user ID" }
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
  "description": "List all smart lists",
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
  "description": "List all automations",
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
  "description": "List people in automations",
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
  "description": "Create an appointment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "personId": { "type": "number", "description": "Person ID" },
      "appointmentTypeId": { "type": "number", "description": "Appointment type ID" },
      "appointmentOutcomeId": { "type": "number", "description": "Outcome ID" },
      "invitees": { "type": "array", "description": "Invitees", "items": { "type": "object" } },
      "startTime": { "type": "string", "description": "Start time ISO" },
      "endTime": { "type": "string", "description": "End time ISO" },
      "title": { "type": "string", "description": "Appointment title" },
      "description": { "type": "string", "description": "Description" },
      "location": { "type": "string", "description": "Location" }
    },
    "required": []
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
  "description": "Update an appointment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Appointment ID" },
      "personId": { "type": "number", "description": "Person ID" },
      "appointmentTypeId": { "type": "number", "description": "Type ID" },
      "appointmentOutcomeId": { "type": "number", "description": "Outcome ID" },
      "invitees": { "type": "array", "description": "Invitees", "items": { "type": "object" } },
      "startTime": { "type": "string", "description": "Start time" },
      "endTime": { "type": "string", "description": "End time" },
      "title": { "type": "string", "description": "Title" },
      "description": { "type": "string", "description": "Description" },
      "location": { "type": "string", "description": "Location" }
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
      "stage": { "type": "string", "description": "Filter by stage" },
      "assignedUserId": { "type": "number", "description": "Filter by assigned user" },
      "assignedTo": { "type": "string", "description": "Filter by assigned name" }
    },
    "required": []
  }
},
{
  "name": "createDeal",
  "description": "Create a deal",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pipelineId": { "type": "number", "description": "Pipeline ID" },
      "stageId": { "type": "number", "description": "Stage ID" },
      "personId": { "type": "number", "description": "Person ID" },
      "userIds": { "type": "array", "description": "Assigned user IDs", "items": { "type": "number" } },
      "name": { "type": "string", "description": "Deal name" },
      "value": { "type": "number", "description": "Deal value" },
      "closingDate": { "type": "string", "description": "Closing date ISO" },
      "orderWeight": { "type": "number", "description": "Sort order weight" }
    },
    "required": []
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
  "description": "Update a deal",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Deal ID" },
      "name": { "type": "string", "description": "Name" },
      "pipelineId": { "type": "number", "description": "Pipeline ID" },
      "stageId": { "type": "number", "description": "Stage ID" },
      "personId": { "type": "number", "description": "Person ID" },
      "userIds": { "type": "array", "description": "User IDs", "items": { "type": "number" } },
      "value": { "type": "number", "description": "Value" },
      "description": { "type": "string", "description": "Description" }
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
  "description": "Attach a file to a deal",
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
  "description": "Create a deal custom field",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Field name" },
      "type": { "type": "string", "description": "Field type" },
      "options": { "type": "array", "description": "Dropdown options", "items": { "type": "string" } }
    },
    "required": ["name", "type"]
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
      "name": { "type": "string", "description": "Name" },
      "type": { "type": "string", "description": "Type" },
      "options": { "type": "array", "description": "Options", "items": { "type": "string" } }
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
  "description": "Remove a participant from an inbox app conversation",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversationId": { "type": "string", "description": "Conversation ID" },
      "personId": { "type": "number", "description": "Person ID to remove" }
    },
    "required": ["conversationId", "personId"]
  }
},
{
  "name": "inboxAppInstall",
  "description": "Install an inbox app",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "App name" },
      "url": { "type": "string", "description": "App URL" }
    },
    "required": ["name", "url"]
  }
},
{
  "name": "inboxAppDeactivate",
  "description": "Deactivate the inbox app",
  "inputSchema": { "type": "object", "properties": {}, "required": [] }
},
{
  "name": "listInboxAppInstallations",
  "description": "List inbox app installations",
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

]; // end TOOL_DEFINITIONS

// ---------------------------------------------------------------------------
// Tool Handler
// ---------------------------------------------------------------------------

async function handleToolCall(name, args) {
  try {
    switch (name) {

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
      return { peopleRelationships: response.data.peopleRelationships, _metadata: response.data._metadata };
    }
    case 'createRelationship': {
      const response = await fubApi.post('/peopleRelationships', args);
      return response.data;
    }
    case 'getRelationship': {
      const response = await fubApi.get(`/peopleRelationships/${args.id}`);
      return response.data;
    }
    case 'updateRelationship': {
      const { id, ...body } = args;
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
      const response = await fubApi.post('/calls', args);
      return response.data;
    }
    case 'getCall': {
      const response = await fubApi.get(`/calls/${args.id}`);
      return response.data;
    }
    case 'updateCall': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/calls/${id}`, body);
      return response.data;
    }

    // ==================== TEXT MESSAGES ====================
    case 'listTextMessages': {
      const response = await fubApi.get('/textMessages', { params: args });
      return { textMessages: response.data.textMessages, _metadata: response.data._metadata };
    }
    case 'createTextMessage': {
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
      return { smartLists: response.data.smartLists, _metadata: response.data._metadata };
    }
    case 'getSmartList': {
      const response = await fubApi.get(`/smartLists/${args.id}`);
      return response.data;
    }

    // ==================== ACTION PLANS ====================
    case 'listActionPlans': {
      const response = await fubApi.get('/actionPlans', { params: args });
      return { actionPlans: response.data.actionPlans, _metadata: response.data._metadata };
    }
    case 'listActionPlansPeople': {
      const response = await fubApi.get('/actionPlansPeople', { params: args });
      return { actionPlansPeople: response.data.actionPlansPeople, _metadata: response.data._metadata };
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
      const response = await fubApi.get('/automations', { params: args });
      return { automations: response.data.automations, _metadata: response.data._metadata };
    }
    case 'getAutomation': {
      const response = await fubApi.get(`/automations/${args.id}`);
      return response.data;
    }
    case 'listAutomationsPeople': {
      const response = await fubApi.get('/automationsPeople', { params: args });
      return { automationsPeople: response.data.automationsPeople, _metadata: response.data._metadata };
    }
    case 'getAutomationPerson': {
      const response = await fubApi.get(`/automationsPeople/${args.id}`);
      return response.data;
    }
    case 'addPersonToAutomation': {
      const response = await fubApi.post('/automationsPeople', args);
      return response.data;
    }
    case 'updateAutomationPerson': {
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
      return { textMessageTemplates: response.data.textMessageTemplates, _metadata: response.data._metadata };
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
      return { emEvents: response.data.emEvents, _metadata: response.data._metadata };
    }
    case 'createEmEvent': {
      const response = await fubApi.post('/emEvents', args);
      return response.data;
    }
    case 'listEmCampaigns': {
      const response = await fubApi.get('/emCampaigns', { params: args });
      return { emCampaigns: response.data.emCampaigns, _metadata: response.data._metadata };
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
      return { customFields: response.data.customFields, _metadata: response.data._metadata };
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
      const response = await fubApi.post('/appointments', args);
      return response.data;
    }
    case 'getAppointment': {
      const response = await fubApi.get(`/appointments/${args.id}`);
      return response.data;
    }
    case 'updateAppointment': {
      const { id, ...body } = args;
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
      return { appointmentTypes: response.data.appointmentTypes, _metadata: response.data._metadata };
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
      return { appointmentOutcomes: response.data.appointmentOutcomes, _metadata: response.data._metadata };
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
      const response = await fubApi.get('/webhooks');
      return { webhooks: response.data.webhooks, _metadata: response.data._metadata };
    }
    case 'createWebhook': {
      const response = await fubApi.post('/webhooks', args);
      return response.data;
    }
    case 'getWebhook': {
      const response = await fubApi.get(`/webhooks/${args.id}`);
      return response.data;
    }
    case 'updateWebhook': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/webhooks/${id}`, body);
      return response.data;
    }
    case 'deleteWebhook': {
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
      const response = await fubApi.post('/deals', args);
      return response.data;
    }
    case 'getDeal': {
      const response = await fubApi.get(`/deals/${args.id}`);
      return response.data;
    }
    case 'updateDeal': {
      const { id, ...body } = args;
      const response = await fubApi.put(`/deals/${id}`, body);
      return response.data;
    }
    case 'deleteDeal': {
      await fubApi.delete(`/deals/${args.id}`);
      return { success: true, message: `Deal ${args.id} deleted` };
    }

    // ==================== DEAL ATTACHMENTS ====================
    case 'createDealAttachment': {
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
      return { dealCustomFields: response.data.dealCustomFields, _metadata: response.data._metadata };
    }
    case 'createDealCustomField': {
      const response = await fubApi.post('/dealCustomFields', args);
      return response.data;
    }
    case 'getDealCustomField': {
      const response = await fubApi.get(`/dealCustomFields/${args.id}`);
      return response.data;
    }
    case 'updateDealCustomField': {
      const { id, ...body } = args;
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
      return { teamInboxes: response.data.teamInboxes, _metadata: response.data._metadata };
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
    case 'inboxAppAddMessage': {
      const response = await fubApi.post('/inboxApps/addMessage', args);
      return response.data;
    }
    case 'inboxAppUpdateMessage': {
      const response = await fubApi.put('/inboxApps/updateMessage', args);
      return response.data;
    }
    case 'inboxAppAddNote': {
      const response = await fubApi.post('/inboxApps/addNote', args);
      return response.data;
    }
    case 'inboxAppUpdateConversation': {
      const response = await fubApi.put('/inboxApps/updateConversation', args);
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
      await fubApi.delete('/inboxApps/participants', { data: args });
      return { success: true, message: 'Participant removed' };
    }
    case 'inboxAppInstall': {
      const response = await fubApi.post('/inboxApps/install', args);
      return response.data;
    }
    case 'inboxAppDeactivate': {
      await fubApi.delete('/inboxApps/deactivate');
      return { success: true, message: 'Inbox app deactivated' };
    }
    case 'listInboxAppInstallations': {
      const response = await fubApi.get('/inboxApps/installations');
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

const server = new Server(
  { name: 'followupboss-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleToolCall(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Follow Up Boss MCP Server v1.0.0 started (${TOOL_DEFINITIONS.length} tools)`);
}

main().catch(console.error);
