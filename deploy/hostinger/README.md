# One-click install on Hostinger

Run your own Follow Up Boss MCP server on a Hostinger VPS and connect it to Claude on the web, desktop or phone. Your server, your API key, your data. Nobody else sees it.

[![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/docker-hosting?compose_url=https%3A%2F%2Fraw.githubusercontent.com%2Fmindwear-capitian%2Ffollowupboss-mcp-server%2Fmain%2Fdeploy%2Fhostinger%2Fdocker-compose.yml&REFERRALCODE=LKDTGEDSNSTG)

## Steps

1. Click **Deploy on Hostinger** above.
2. Pick the **KVM 1** plan. It is more than enough for this server.
3. Finish checkout. Hostinger sets up the server and opens **Docker Manager** with this project.
4. In Docker Manager, set two values:
   - `FUB_API_KEY`: your Follow Up Boss API key (in FUB: **Admin > API**).
   - `MCP_AUTH_PASSWORD`: a password you make up, **12 or more characters**. Claude asks for it once.
5. Click **Deploy**.
6. Find your server's address in hPanel. It looks like `srv123456.hstgr.cloud`.
7. In Claude, open **Settings > Connectors > Add custom connector** and enter `https://srv123456.hstgr.cloud/mcp` (use your address).
8. Claude opens a sign-in page. Enter your password from step 4.

The first visit takes a few seconds while the server gets its free HTTPS certificate.

## Good to know

- **Safe Mode is on.** Delete tools are off. To turn them on, set `FUB_SAFE_MODE=false` and redeploy.
- **Wrong passwords lock out.** Five wrong tries from one address block that address for 15 minutes.
- **Your own domain:** point it at the server, set `DOMAIN=fub.yourdomain.com`, redeploy, and use `https://fub.yourdomain.com/mcp`.
- **Updates:** in Docker Manager, pull the latest image and redeploy. Your Claude connection stays signed in.
