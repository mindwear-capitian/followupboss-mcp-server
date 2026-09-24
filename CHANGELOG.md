# Changelog

All notable changes to this project will be documented in this file.

## v1.5.3 — 2026-09-24

All changes in this release were contributed by **Joe Feser**
([@joefeser](https://github.com/joefeser)). Thank you, Joe.

### Fixed

- **Safe Mode did not block `inboxAppDeactivate`** (#16). The tool sends an
  HTTP `DELETE` to `/inboxApps/{id}`, but Safe Mode only matched tools named
  `delete*`, so it stayed available. It is now blocked and hidden. Safe Mode
  now exposes 136 of 160 tools (was 137). The docs now state plainly that Safe
  Mode blocks deletes only; create, update, and bulk-update tools stay enabled.
- **Failed Follow Up Boss calls looked like successes to the AI client** (#17).
  API errors were returned as ordinary tool results, so the client could not
  tell a failed update from a successful one. They are now flagged
  `isError: true`, as the MCP spec requires. Unknown tool names are flagged the
  same way. Error text now redacts the API key, the system key, and
  credential-like fields. Code that imports `handleToolCall` directly gets the
  same plain-object results as before.
- **`getPersonByEmail` silently picked one contact when several shared an
  email** (#18). It now returns `ambiguous: true` with the match count and the
  candidate IDs and names, so the caller chooses. Zero-match and single-match
  results are unchanged.

### Security

- Dependency updates: `fast-uri` 3.1.8 (#13, #19), `qs` 6.16.0 with Express
  4.22.3, with no Express 5 migration (#14, #20), and `hono` 4.13.8 (#15, #21).
  `npm audit` reports 0 vulnerabilities.

## v1.5.2 — 2026-08-21

### Fixed

- **HTTP-mode server memory grew over time because idle sessions were never
  evicted.** Scope: server RAM usage only. Each HTTP client session gets its
  own transport and server instance, held in an in-memory map. The entry was
  removed only when the client sent an explicit HTTP DELETE — but common MCP
  clients (Claude Desktop, Claude.ai) abandon sessions on reconnect instead of
  closing them, so abandoned entries accumulated until process restart.
  Sessions now expire after 30 minutes of inactivity (tunable via
  `MCP_SESSION_IDLE_MS`); an expired client transparently re-initializes on
  its next request. To be explicit about what this is and is not: session
  objects hold MCP protocol state and tool registrations only. They contain no
  Follow Up Boss data, no credentials, and nothing user-supplied. No data was
  exposed, logged, or retained — this fix is resource management (unbounded
  RAM growth in long-running HTTP deployments), not a data or privacy issue.
  stdio mode was never affected.

### Added

- `/health` now reports `sessions` (live HTTP session count) so operators can
  monitor session churn directly instead of inferring it from memory usage.

## v1.5.1 — 2026-08-15

### Fixed

- **Custom fields are now documented on person tools** (closes #10). The FUB API
  has always accepted custom fields as top-level keys prefixed with `custom`
  (e.g. `customClosingDate`) on person create/update, and the server always
  passed them through — but the tool descriptions never said so, so AI clients
  reported that custom fields could not be imported. `createPerson`,
  `updatePerson`, `bulkUpdatePeople`, and `getPerson` now spell out how to read,
  write, and clear custom fields.
- **`listCustomFields` and `listDealCustomFields` were capped at 10 results.**
  Neither passed pagination parameters to the API, so accounts with more than
  10 custom fields could never see the full list. Both now accept `limit` and
  `offset` (pass `limit=100` to fetch all).

## v1.5.0 — 2026-08-13

### Added

- MCPB desktop bundle for one-click install into Claude Desktop, published as a
  GitHub release asset and listed on the official MCP Registry as
  `com.neuhausre/followupboss`.

## v1.4.5 — 2026-07-31

### Changed (packaging)

- **Added a `files` allowlist to `package.json`.** Installs previously shipped
  everything not gitignored — `test.js`, `test-e2e.js`, `test-fixes.js`,
  `tests/`, `AUDIT_REPORT.md`, `SECURITY.md`, `CONTRIBUTING.md` — none of which
  run at runtime. Installed packages now carry only `index.js`, `setup.js`,
  `README.md`, `LICENSE`, `NOTICE`, and `CHANGELOG.md`.
- Smaller installs, and the shipped tree now matches what actually executes.

**Cloning from GitHub is unaffected.** `git clone` still gets the full repo
including every test, and `npm test` works exactly as before. This only changes
what a packaged install contains.

No code changes. `index.js` is byte-identical to v1.4.3.

## v1.4.4 — 2026-07-30

### Changed (docs / licensing)

- **Contributor license grant added to `CONTRIBUTING.md`.** The old wording was
  inbound=outbound: contributions came in under ELv2, the same license the repo
  ships under. That is fine for a permissive license and wrong for a restricted
  one — ELv2 bars offering the software as a hosted or managed service, so
  contributed code carried that restriction into the project itself, and donated
  lines could block the maintainer from running a hosted version.
- Contributors now keep their copyright and grant the maintainer a perpetual,
  irrevocable, royalty-free license covering commercial and hosted-service use.
  Contributions are still published publicly under ELv2.
- **Self-hosting is unchanged: free, unrestricted, all 160 tools.** This affects
  contributors only, and only from this release forward.
- **New `.github/pull_request_template.md`** with sanity-check items and an
  agreement checkbox, so the grant is acknowledged per PR instead of buried in
  CONTRIBUTING.

No code changes. `index.js` is byte-identical to v1.4.3.

## v1.4.3 — 2026-07-24

### Fixed (test-only)

- **`npm test` no longer reports a pass on an invalid API key** (PR #4, thanks
  @drew778) — the read-only check accepted any non-empty object, including FUB's
  401 error payload. Follow-up: the identity-field check now also accepts the
  `{ account: { id, domain, owner } }` response shape, which real accounts
  return and which the PR's stricter check missed.

## v1.4.2 — 2026-07-24

### Changed

- **`recordingUrl` now explains itself instead of teasing.** FUB masks call
  recording URLs at the API level for every integration (`* Recording URL is
  hidden for privacy reasons *`) and has confirmed they will never be exposed
  through the API. That mystery string kept generating "can you unhide it?"
  support questions (issue #2). The call tools (`listCalls`, `getCall`,
  `createCall`, `updateCall`) now replace any masked value with a note that
  states the reality and points to the README.
- **`recordingUrl` removed from `createCall`/`updateCall` inputs.** Verified
  live: a URL written to a call comes back masked -- writing the field is a
  black hole. Legacy callers that still send it are silently tolerated
  (`translateCallArgs` drops it) instead of erroring.
- README: new FAQ entry "Where are the call recording URLs?"

## v1.4.1 — 2026-07-18

### Fixed (bug)

- **OAuth client registrations and access tokens no longer die on every
  restart.** `clients` and `accessTokens` were plain in-memory `Map`s in
  `startHttp()` -- any process restart (redeploy, crash, host reboot) wiped
  them, so every previously-authorized Claude.ai/Claude Code connection broke
  with `Invalid client_id` or `401 unauthorized` on its next request, and
  had to redo the full DCR + PKCE + password flow. This hit real self-hosted
  OAuth deployments repeatedly -- three routine redeploys in nine days each
  silently logged out every connected client.

  Both Maps now persist to a JSON file on disk (plain `fs`, no new
  dependency), reloaded on boot and rewritten on client registration, token
  issuance, and expired-token cleanup. `authCodes` (5-minute TTL) intentionally
  stays in-memory -- losing one mid-flight just means retry the login page,
  not worth a disk write per auth attempt.

  New optional env var `MCP_OAUTH_STORE_PATH` (default
  `./data/oauth-store.json`) controls the store location -- **mount a
  persistent volume at this path in Docker/Railway/Fly deployments**, or the
  fix does nothing for you (the file dies with the container same as before).

  Added `tests/http-integration.sh` Section 3: registers a client, kills the
  server process, restarts it against the same store path, and confirms the
  old client_id and access_token both still work with zero re-registration.
  Confirmed this section fails against the pre-fix code (`Invalid client_id`,
  `401 unauthorized`) and passes after.

## v1.4.0 — 2026-07-10

### Security

- **Safe Mode is now ON by default (was silently OFF).** `FUB_SAFE_MODE` was
  evaluated as `=== 'true'`, so an unset or unrecognized value left Safe Mode
  **off** and exposed all 23 delete tools — while `SECURITY.md`, `README.md`,
  the `.env.example`, and the in-app `help` tool all stated that Safe Mode was
  the default. Anyone who set `FUB_API_KEY` directly in an MCP host config (a
  documented setup path) got an AI agent holding 22 `delete*` tools against a
  live CRM despite the docs promising deletion was disabled. The flag is now
  evaluated as `!== 'false'`: unset ⇒ **SAFE**. Opt into Full Access explicitly
  with `FUB_SAFE_MODE=false`. ([GHSA advisory](../../security/advisories))

- **Safe Mode is now enforced inside `handleToolCall`, the single dispatch
  choke point.** The guard previously lived only in `createServer`'s
  `CallToolRequestSchema` handler, so private overlays and forks that import and
  call the exported `handleToolCall` directly received **no** Safe Mode
  enforcement — a `deletePerson` call would reach the FUB API even with
  `FUB_SAFE_MODE=true`. The check now runs in `handleToolCall` itself (with the
  server-handler guard retained as defense-in-depth), and the duplicated
  delete-tool predicate is consolidated into a single exported `isDeleteTool()`
  helper.

  Both issues were reported privately and responsibly (no public disclosure) by
  **Drew Coleman**, broker-owner at Opt Real Estate (Portland, OR) — with exact
  line references, reproductions, and suggested fixes. Thank you, Drew.

### Fixed (bug)

- **Version banners and metadata now read from `package.json`.** The stdio/HTTP
  startup banners were hardcoded to `v1.3.1`, and the `about` / `/health`
  responses to `1.3.3`, drifting from the real package version. All now derive
  from a single `VERSION` constant.

### Compatibility

- **Behavior change:** if you were relying on delete tools working *without*
  setting `FUB_SAFE_MODE`, you must now set `FUB_SAFE_MODE=false` explicitly.
  Existing configs that already set the value either way are unaffected. This is
  the intended security hardening — deletion is opt-in, not opt-out.

### Security housekeeping

- `npm audit fix` resolved 8 transitive advisories (6 high, 2 moderate;
  lockfile only, no API surface change). `npm audit` now reports 0
  vulnerabilities.

## v1.3.3 — 2026-07-03

### Fixed (bug)

- **`listDeals` filter parameters now match the FUB API.** The tool previously exposed `stage`, `assignedUserId`, and `assignedTo` — none of which the FUB `GET /v1/deals` endpoint accepts — so filtering deals by stage or assigned user was silently ignored and returned unfiltered results. Replaced with the real API params: `stageId`, `userId`, `personId`, `includeArchived`, `includeDeleted`, and `status` (`Active` / `Archived`; note that the API's `Deleted` status value does not filter, so `includeDeleted=1` is documented as the way to surface deleted deals). Verified against the live FUB API.

  Thanks to **Tony Greising-Murschel** ([@tony-dot-sh](https://github.com/tony-dot-sh)) for finding and fixing this.

### Compatibility

Backward compatible at the transport level. Any caller that was passing the old `stage` / `assignedUserId` / `assignedTo` params (which never worked) should switch to `stageId` / `userId`.

## v1.3.2 — 2026-06-06

### Fixed (bug)

- **`createDeal` / `updateDeal` no longer fail when a commission is set.** The handler used to translate the `agentCommission` / `teamCommission` tool params to the historically-misspelled FUB field names (`agentCommision` / `teamComission`, single `s`). Follow Up Boss has since corrected those field names and now **rejects the misspelled keys with HTTP 400** (`Invalid fields in the request body: agentCommision, teamComission`), so any deal create/update that included a commission hard-failed. The params are now passed straight through with their correct spelling. Verified against the live FUB API on 2026-06-06.

### Compatibility

Fully backward compatible. Tool schemas unchanged (`agentCommission` / `teamCommission` were already the public param names). No env or transport changes.

## v1.3.1 — 2026-05-19

### Added (non-breaking)

- **Exported API** for programmatic use. The following are now importable as ES modules from `index.js`: `createServer`, `startStdio`, `startHttp`, `activeTools`, `TOOL_DEFINITIONS`, `handleToolCall`, `FUB_SAFE_MODE`. Used by private/branded deployments that layer custom tools on top of the public surface.
- **`createServer({ extraTools, extraHandler, serverInfo })`** options object. Callers can merge additional tool definitions and a fallback handler without forking the package.
- **`startStdio(opts)` / `startHttp(opts)`** accept the same `opts` and pass through to `createServer`. Stdio and HTTP transports now share the same overlay surface.
- **Auto-run guard.** `main()` only runs when `index.js` is invoked directly (`process.argv[1] === fileURLToPath(import.meta.url)`). Imports as a module no longer auto-start a transport.

### Why

Private/branded forks were either copying the entire 3,500-line `index.js` (and drifting over time) or maintaining a separate tool surface. The new exports let them `import { createServer } from 'followupboss-mcp-server'` and add their own messaging/cookie-auth tools as an overlay. Public stays the single source of truth for the FUB API surface.

### Compatibility

Fully backward compatible. Default behavior unchanged for stdio + HTTP users. No new env vars required. No tool changes. Test suite: 3/3 stdio + 38/38 HTTP integration + 9/9 import-overlay tests pass.

---

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
