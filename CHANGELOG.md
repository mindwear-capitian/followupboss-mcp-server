# Changelog

All notable changes to this project will be documented in this file.

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
