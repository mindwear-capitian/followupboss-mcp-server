# MCP Registry Listing

Published to the Official MCP Registry as **`com.neuhausre/followupboss`**, first listed
2026-08-13 at v1.5.0.

Verify: `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=com.neuhausre"`

## Why MCPB and not npm

The registry accepts several package types. MCPB publishes straight from a **GitHub release
asset** — no npm account, no package publish, no third-party registry in the chain. The same
artifact also gives realtors one-click install into Claude Desktop, which was the whole
barrier to self-hosting. One file solves distribution and listing together.

Requirements the registry enforces for MCPB: the asset URL must contain the string `mcp`
(ours does, via the repo name), and `fileSha256` must be present. The registry does not
verify that hash, but **MCP clients do** before installing — so it must be the hash of the
asset as actually published, not a local build.

```bash
curl -sL <release-asset-url> -o /tmp/check.mcpb
openssl dgst -sha256 /tmp/check.mcpb
```

## Release procedure

1. Bump `version` in `package.json`, `manifest.json`, and `server.json`. All three must match.
2. Build a clean bundle with production dependencies only:
   ```bash
   rm -rf /tmp/fub-mcpb && mkdir -p /tmp/fub-mcpb
   cp index.js setup.js package.json package-lock.json manifest.json \
      README.md LICENSE NOTICE CHANGELOG.md /tmp/fub-mcpb/
   cd /tmp/fub-mcpb && npm ci --omit=dev
   npx --yes @anthropic-ai/mcpb@latest validate manifest.json
   npx --yes @anthropic-ai/mcpb@latest pack . /tmp/followupboss-mcp-server-<version>.mcpb
   ```
3. Tag, push, and create the release with the bundle attached (`gh release create`).
4. Download the published asset and hash it. Put that hash in `server.json`.
5. Publish from the Mac — `mcp-publisher` lives there, not on a VPS. Log in and publish in
   the **same step**; the JWT expires within minutes.
   ```bash
   PK=$(op document get "MCP Registry Signing Key (neuhausre.com)" --vault Claude \
        | openssl pkey -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')
   mcp-publisher login dns --domain neuhausre.com --private-key "$PK"
   mcp-publisher publish
   ```

Namespace setup and signing key: see the `com.neuhausre` section in the neuhaus-vow-mcp repo
docs. The key lives only in 1Password (Claude vault, `MCP Registry Signing Key
(neuhausre.com)`).

## Hard constraints

- **Nothing can be unpublished.** Versions are immutable and there is no delete. Name,
  description, and version are permanent once sent.
- `description` is capped at 100 characters.
- **Never publish a hosted instance of this server.** `mcp.re-workflow.com` stays private and
  single-tenant. Follow Up Boss API terms bar implementations where their API is the primary
  functionality, and that clause is price-independent — a free hosted tier does not cure it.
  Only this open-source self-host package is listable, because the customer holds their own
  key and their own liability.
- The bundle must never ship a credential of ours. `manifest.json` collects the user's own
  API key (and optional registered-system name/key) through `user_config`; Claude Desktop
  stores them and passes them as env vars at runtime.

## Manifest notes

- `tools_generated: true` — the active tool list depends on Safe Mode, which hides the 24
  DELETE-backed tools by default, leaving 136 of 160.
- `FUB_SAFE_MODE` fails safe: the code treats anything other than the exact string `false` as
  safe, so an empty or missing value still blocks deletes.
