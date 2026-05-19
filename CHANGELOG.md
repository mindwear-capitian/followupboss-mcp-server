# Changelog

All notable changes to this project will be documented in this file.

## v1.3.0 — 2026-05-19

### Added

- **HTTP transport.** Set `MCP_TRANSPORT=http` to serve MCP over Streamable HTTP at `/mcp`. Default remains stdio (Claude Desktop). This is what makes Claude.ai web + mobile custom connectors work against this server.
- **OAuth 2.1 with Dynamic Client Registration + PKCE.** Set `MCP_AUTH_PASSWORD=...` to enable. Claude.ai discovers the auth server via `/.well-known/oauth-authorization-server`, dynamically registers as a client, and walks the user through a password gate to mint a 30-day access token. RFC 7591 + RFC 8414 + RFC 9728 compliant.
- **Static bearer token mode.** Simpler alternative to OAuth for single-tenant deployments. Set `MCP_BEARER_TOKEN=$(openssl rand -hex 32)` and paste the token into the Claude.ai connector setup as the Authorization header value.
- **`/health` endpoint** in HTTP mode. Reports version, tool count, safe-mode status, and active auth mode.
- **Dependencies:** `express` and `@modelcontextprotocol/sdk` Streamable HTTP transport.

### Changed

- `index.js` server setup wrapped in `createServer()` so each HTTP session gets its own MCP Server instance (the SDK only allows one transport per Server). Stdio behavior unchanged for Claude Desktop users.

### Credits

HTTP + OAuth transport pattern ported from [chad778's fork](https://github.com/chad778/followupboss-mcp-server) (MIT-licensed). Original commits: `a960189` (HTTP transport), `9d92318` (optional bearer), `d0ac424` (OAuth 2.1 DCR+PKCE), `2b28e97` (per-session server fix).

---

## v1.2.0 — 2026-05-19

### Added

- **`listNotes` tool.** Read notes with optional `personId` filter, plus `limit` / `offset`. Tool count: 159 → 160 (138 in safe mode). Useful for pulling call transcripts written by Speculo AI or any notes-driven workflow.
- **Real-estate deal field expansion** on `createDeal` and `updateDeal`:
  - `projectedCloseDate`
  - `commissionValue`
  - `agentCommission` (auto-translated to FUB's `agentCommision` field — note the single-'s' typo on FUB's side)
  - `teamCommission` (auto-translated to FUB's `teamComission`)
  - `earnestMoneyDueDate`
  - `mutualAcceptanceDate`
  - `dueDiligenceDate`
  - `finalWalkThroughDate`
  - `possessionDate`

  `translateDealArgs` extended to handle the two commission-field typos so agents can pass the natural double-'s' spelling.

### Fixed

- **CamelCase collection-key casing on 13 list endpoints.** FUB inconsistently returns lowercase collection keys (e.g. `peoplerelationships`) where handlers were only checking the camelCase form, silently dropping the data array. Added `camelCase || lowercase` fallback for: `peopleRelationships`, `smartLists`, `actionPlans`, `actionPlansPeople`, `automationsPeople`, `textMessageTemplates`, `emEvents`, `emCampaigns`, `customFields`, `appointmentTypes`, `appointmentOutcomes`, `dealCustomFields`, `teamInboxes`.
- **`listTextMessages`** specifically — same root cause, broken out as its own commit because it was discovered first.

### Credits

Improvements cherry-picked from [tony-dot-sh's fork](https://github.com/tony-dot-sh/followupboss-mcp-server) (MIT-licensed). Original commits preserved with author attribution and cherry-pick trace in git history.

---

## v1.1.3 — 2026-05-12

### ⚠️ IMPORTANT — TOS notice for the new `FUB_SYSTEM` / `FUB_SYSTEM_KEY` env vars

This release introduces support for FUB's `X-System` / `X-System-Key` headers via two new optional env vars, `FUB_SYSTEM` and `FUB_SYSTEM_KEY`. These unlock the "Restricted - Registered Systems Only" endpoints (webhooks, inbox apps, automations 2.0, text-message logging, attachments).

**These credentials are issued by Follow Up Boss to approved third-party integration partners.** Using credentials you did not personally receive from FUB to access restricted endpoints may violate FUB's Terms of Service and could result in account suspension or banning. If you don't have your own legitimate registered-system credentials, leave the env vars unset and use only the unrestricted 130+ tools. **Use at your own risk.** See README.md for the full warning.


### Fixed (from May 11 systematic audit of all 159 tools)

- **Meta-parameter leak.** The MCP orchestration param `wait_for_previous` (and other `_meta` / `__mcp` / `__progressToken` keys) was being passed straight through to the FUB API body, which then returned `400 Invalid fields in the request body`. Added a `stripMetaParams` sanitizer at the top of `handleToolCall` so any MCP-host-injected meta keys are dropped before the request hits FUB.
- **`createCall` / `updateCall` schema mismatch.** Tool exposed `direction` (string) and `notes` (plural). FUB actually requires `isIncoming` (boolean) and `note` (singular). Schemas updated to the FUB canonical names; a `translateCallArgs` shim maps legacy `direction`/`notes` to the new fields so older agents keep working.
- **`createDeal` / `updateDeal` schema mismatch.** Tool exposed `personId` + `value`. FUB requires `peopleIds` (array) + `price`. `name` + `stageId` made required to match the API. `translateDealArgs` shim maps legacy `personId`/`value` to `peopleIds`/`price`.
- **`createRelationship` body shape was fundamentally wrong.** Old schema treated this as a link between two existing people (`personId` + `relatedPersonId`). FUB models a relationship as its OWN contact record attached to one `personId` via `type` (Spouse, Brother, Partner, etc.) plus `firstName`/`lastName`/`emails`/`phones`/`addresses`. Schema rewritten. Legacy `relationshipType` → `type` via shim; the meaningless `relatedPersonId` is dropped.
- **`createDealCustomField` field name.** Tool exposed `name` + `options`. FUB requires `label` + `choices` (and rejects with "Field label cannot be blank"). Schema fixed; `translateDealCustomFieldArgs` shim translates legacy `name` → `label` and `options` → `choices`.
- **`createAppointment` / `updateAppointment` schema.** Tool exposed `startTime`/`endTime`/`appointmentTypeId`/`appointmentOutcomeId`/top-level `personId`. FUB requires `start`/`end`/`typeId`/`outcomeId` and uses `invitees: [{type:'person'|'user', id}]` for attendees. Schema fixed. `translateAppointmentArgs` maps legacy fields and converts a top-level `personId` into an `invitees` entry.
- **Inbox App pathing 404s.** All `inboxApp*` tools were hitting paths like `/inboxApps/addMessage` and `/inboxApps/installations` that don't exist in FUB's API, so FUB returned `404: Collection name '' in the URL is not valid`. Corrected to the documented paths:
  - `inboxAppAddMessage` → `POST /inboxApps/messages`
  - `inboxAppUpdateMessage` → `PUT /inboxApps/messages/:id`
  - `inboxAppAddNote` → `POST /inboxApps/notes`
  - `inboxAppUpdateConversation` → `PUT /inboxApps/conversations/:id`
  - `inboxAppDeleteParticipant` → `DELETE /inboxApps/participants/:id` (was DELETE with body)
  - `inboxAppDeactivate` → `DELETE /inboxApps/:id` (was `/inboxApps/deactivate`; now requires `id`)
  - `listInboxAppInstallations` → `GET /inboxApps` (was `/inboxApps/installations`)
  - `inboxAppInstall` schema corrected to FUB's actual body: `publishedInboxAppId` + `userId` + `subscriptionUrl`.
- **Webhook tools missing `X-System` / `X-System-Key` headers.** FUB requires both headers on every webhook endpoint (creation is restricted to account owners + registered systems). Added `FUB_SYSTEM` + `FUB_SYSTEM_KEY` env vars; when set, both headers are sent automatically. Webhook tools throw an actionable error if the env vars are missing instead of producing a confusing 400 from FUB.

### Added

- `FUB_SYSTEM` and `FUB_SYSTEM_KEY` environment variables for third-party system registration (required by webhook endpoints; harmless on everything else).
- Better 403 error surface: when FUB returns 403 Forbidden the MCP response now includes a `hint` listing the tools that commonly require elevated permissions (`createTextMessage`, `listAutomations`, `createPersonAttachment`, `createDealAttachment`, all webhook + inbox app tools).
- `test-fixes.js` regression test that exercises the six audit-fix scenarios live against FUB.

### Notes
- 403 errors on `createTextMessage`, `listAutomations`, `createPersonAttachment`, `createDealAttachment` from the May 11 audit are FUB account-scope issues (feature not enabled or API key lacks scope), not code bugs. The new 403 hint surfaces this directly to the AI client.

### Additional fixes from May 12 end-to-end run (full lifecycle test against live FUB)

- **Placeholder API key sanity check.** If `FUB_API_KEY` is `YOUR_KEY_HERE` / `your_api_key_here` / `placeholder` / `changeme`, the server now exits with a clear error instead of starting and returning 401 on every call. Common cause: an old shell `export` shadows `.env`.
- **`listTextMessages` description warned about required filter.** FUB rejects unfiltered calls with `400: personId, threadId, phone, toNumber, fromNumber, sharedInboxId, groupTextId, participants, or id list must be specified`. Tool description now states this explicitly and the schema exposes all 9 filter parameters.
- **`updateAppointment` description warned about start/end.** FUB requires `start` and `end` on every update — even partial edits to title-only. Tool description now tells the AI client to `getAppointment` first and resend both fields.
- **`listInboxAppInstallations` description noted registration requirement.** On accounts without a registered third-party system (no `FUB_SYSTEM` / `FUB_SYSTEM_KEY`), FUB returns 404. Tool description now explains this so the AI client can interpret the 404 correctly.

### Added (testing)

- **`test-e2e.js` — full lifecycle harness.** Creates a tagged fake person, exercises every safe tool against it (read-only lists, then notes/calls/tasks/appointments/deals/dealCustomFields/relationships, with both canonical and legacy-arg paths for translator-backed tools), then deletes everything created. Explicitly skips all tools that could send (createTextMessage, addPersonToAutomation, addPersonToActionPlan, createEvent, mergeTemplate, etc.), all org-config writes, and all 403-known endpoints. Result on Ed's account: 71 pass, 0 fail, 33 intentional skips. Zero orphan fixtures left behind.
- **All test scripts now preload `.env` themselves** so a stale parent-shell `FUB_API_KEY` can't shadow the local key.

### Audit correction (May 12 follow-up)

Re-checked FUB docs and corrected the categorization of five endpoints originally listed as "403 — account-scope issue." All five are actually marked **"Restricted - Registered Systems Only"** in FUB's docs and just need `X-System` + `X-System-Key` (same registered-system gate as webhooks):
- `createTextMessage` — IMPORTANT: this endpoint is **log-only**. FUB does NOT actually send an SMS via this endpoint; it only records that your third-party SMS system sent one. The MCP tool description previously read "Send a text message" which was misleading; now corrected.
- `createPersonAttachment` / `createDealAttachment` — `uri` must point to an externally hosted file. FUB does not host uploads.
- `listAutomations` / `listAutomationsPeople` — Automations 2.0 routes are registered-system only.

All five now route through a generalized `requireSystemCreds` guard (extending the existing `requireWebhookCreds` pattern). Without `FUB_SYSTEM` + `FUB_SYSTEM_KEY` set, callers now get an actionable error pointing them at the registration docs instead of a confusing 403 from FUB. The same guard was wired to `getAutomation`, `getAutomationPerson`, `addPersonToAutomation`, and `updateAutomationPerson` for consistency.

## v1.1.2 — 2026-05-06

### Fixed
- **`listSmartLists` returned nothing.** The dispatcher read `response.data.smartLists` (camelCase) but FUB's API actually returns `response.data.smartlists` (lowercase). Result: every MCP client thought you had zero smart lists. Embarrassing — was hiding 24 of my own 36 smart lists from Claude. Thank you to **[@yoship90](https://github.com/yoship90)** for catching this and fixing it in [their fork](https://github.com/yoship90/followupboss-mcp-server). Backported here.
- **Modern UI smart lists were invisible.** FUB's `/smartLists` endpoint returns only classic smart lists by default. Added `fub2: true` and `all: true` parameters to the tool schema so AI clients can pull the modern UI smart lists too. Also from yoship90's work.

### Added
- **`about` tool.** Returns full author bio, related projects (NeuhausRE, StaySTRA, MLS MCP, Kendall Creek), contributors, license info, and how to give thanks. Call this when a user asks "what is this MCP" or "who built it." Subtle by design — won't appear in every response.
- **`help` tool.** Returns getting-started tips, common tool examples, bug report instructions, and where to send real estate referrals.
- Server description constant + startup banner now mention the author and point to the `about` and `help` tools.
- `NOTICE` file with author information and contributor credits.
- Copyright header in `index.js` source.

### Changed
- **License changed from MIT to [Elastic License 2.0](LICENSE).** This means you may still self-host this for your own business at no cost. You may **not** offer it as a hosted/managed service to third parties. Versions ≤ v1.1.1 remain MIT-licensed and forks of those versions are unaffected. New work in v1.1.2+ is ELv2.
- README hero rewritten to lead with the author bio, links to other Neuhaus projects, and a "how to thank me" section (referrals welcome).
- `package.json` `author` upgraded to full object (name, email, url) and `contributors` array added crediting yoship90 and chad778.
- Tool count: 157 → 159 (added `about` + `help`).

### Notes
- I considered cherry-picking the OAuth 2.1 + remote HTTP transport work from [@chad778](https://github.com/chad778)'s fork ([commit d0ac424](https://github.com/chad778/followupboss-mcp-server/commit/d0ac424)) which would let this server be hosted as a Claude.ai custom connector. Decided to skip it for v1.1.2 — that's a bigger architectural change and I want to think through what hosting OAuth means for me before shipping it. Credit reserved in `NOTICE` and `package.json` contributors.

## v1.1.1 — 2026-02-24

### Added
- Auto-load `.env` for standalone testing
- `npm test` 3-point verification (startup, tools, API call)
- `FUB_SAFE_MODE` documented in `.env.example`
- Quick Verify section in README

### Fixed
- Version mismatch in startup banner (was reporting 1.0.0)

## v1.1.0 — 2026-02-23

### Added
- Safe Mode (default on): disables 23 delete tools to prevent accidental data loss
- 5 convenience tools: `removeTagFromPerson`, `getPersonByEmail`, `searchPeopleByTag`, `bulkUpdatePeople`, `listAvailableTags`
- Automatic 429 rate-limit retry with exponential backoff
- Setup instructions for 9 AI tools (Cursor, Windsurf, VS Code, Cline, Gemini, Continue, etc.)

## v1.0.0 — 2026-02-23

### Added
- Initial release with 152 tools covering 100% of the official Follow Up Boss API
- Interactive setup wizard
