# Follow Up Boss MCP Server - Systematic Audit Report (May 11, 2026)

This report documents the findings from a systematic test of the 159 tools available in the Follow Up Boss MCP server. It identifies critical bugs, schema mismatches, and architectural issues that need to be addressed to make the server fully production-ready.

---

## 1. The "Meta-Parameter Leak" (Critical Logic Bug)
**Description:** When the agent uses `wait_for_previous: true` (a standard MCP orchestration parameter), the server passes this parameter into the `args` object sent to the FUB API.
**Impact:** FUB rejects the request with a `400 Bad Request: Invalid fields in the request body: wait_for_previous`.
**Fix:** The `index.js` (or `index.ts`) must strip `wait_for_previous` from the `args` object before sending the request to the FUB API.

---

## 2. Schema Mismatches (Payload Errors)
The tool definitions (inputSchemas) use field names that the FUB API does not recognize.

### A. Calls (`createCall`)
- **Current Tool Schema:** `direction` (string), `notes` (string)
- **FUB API Requirement:** `isIncoming` (boolean), `note` (singular string)
- **Status:** **BROKEN**. Rejects the tool's default fields.

### B. Deals (`createDeal`)
- **Current Tool Schema:** `pipelineId`, `personId` (integer), `value` (number)
- **FUB API Requirement:** `peopleIds` (array of integers), `price` (number)
- **Status:** **BROKEN**. Rejects `personId` and `value`.

### C. Relationships (`createRelationship`)
- **Current Tool Schema:** `relatedPersonId`
- **FUB API Observation:** API rejects `relatedPersonId`.
- **Status:** **BROKEN**. Needs verification of the correct relationship body structure (likely part of the person object or a specific relationship array).

### D. Custom Fields (`createDealCustomField`)
- **Current Tool Schema:** `name`
- **FUB API Requirement:** `label`
- **Status:** **BROKEN**. Returns "Field label cannot be blank."

### E. Appointments (`createAppointment`)
- **Current Tool Schema:** `personId` (in body)
- **FUB API Observation:** Rejects `personId` in the body. Likely requires the person to be added to the `invitees` array.
- **Status:** **BROKEN**.

---

## 3. Pathing & Routing Errors (404)
The Inbox App suite fails because the server constructs an invalid URL path.

- **Tools Affected:** `listInboxAppInstallations`, `inboxAppGetParticipants`, and likely all `inboxApp...` tools.
- **Error:** `404: Collection name '' in the URL is not valid.`
- **Diagnosis:** The code is failing to append the correct collection name (e.g., `inboxAppInstallations`) to the API base URL.

---

## 4. Missing Identification (Webhooks)
- **Tools Affected:** `listWebhooks`, `createWebhook`
- **Error:** `400: Missing required field in the request: system.`
- **Fix:** FUB requires a `system` header or property to identify the third-party application managing webhooks. The MCP server is not currently providing this.

---

## 5. API Permission Obstacles (403)
These tools return `403 Forbidden`. While often due to account-level settings, they should be reviewed for header issues (like missing scopes).
- `createTextMessage`
- `listAutomations`
- `createPersonAttachment`
- `createDealAttachment`

---

## 6. Verification Status of "Pillar" Tools
These tools are **VERIFIED WORKING** and can be relied upon:
- **Identity:** `getIdentity`
- **People:** `createPerson`, `getPerson`, `updatePerson`, `listPeople`, `getPersonByEmail`, `searchPeopleByTag`
- **Notes:** `createNote`, `getNote`, `updateNote`
- **Discovery:** `listPipelines`, `listStages`, `listDeals`, `listUsers`, `listGroups`, `listSmartLists`, `listTemplates`
- **Tasks:** `listTasks`, `createTask` (when clean)

---

## 7. Next Session Blueprint
To fix these issues, we need to:
1.  **Modify `index.js`**: Implement a "sanitizer" to strip `wait_for_previous`.
2.  **Update Tool Definitions**: Rename fields in `createCall`, `createDeal`, and `createDealCustomField` to match the FUB API exactly.
3.  **Fix Pathing**: Update the `inboxApp` route handlers to correctly construct the FUB URL.
4.  **Add System ID**: Add a default `system` name to the webhook tools.
