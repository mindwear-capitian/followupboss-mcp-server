# One-click install on Hostinger

Talk to your Follow Up Boss CRM from Claude on the web, desktop or phone. This puts the connection on a small server that you own. Your key and your data stay on your server.

No coding. About 15 minutes.

[![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/docker-hosting?compose_url=https%3A%2F%2Fraw.githubusercontent.com%2Fmindwear-capitian%2Ffollowupboss-mcp-server%2Fmain%2Fdeploy%2Fhostinger%2Fdocker-compose.yml&REFERRALCODE=LKDTGEDSNSTG)

## Before you start

Have these 3 things:

- Admin access to your Follow Up Boss account. (If you do not see **Admin** in the top bar of FUB, ask your account owner to do step 1 for you.)
- A Claude account at [claude.ai](https://claude.ai).
- A notes app or a piece of paper, to keep 2 things for a few minutes.

## Step 1: Get your Follow Up Boss API key

1. Sign in to Follow Up Boss.
2. In the top bar, click **Admin**.
3. Under **Integrations**, click **API Keys & Lead Email**.
4. Click **Create API Key**. Name it `Claude`.
5. Copy the key and paste it in your notes. Keep it private.

## Step 2: Make a password

Make up a password of **12 or more characters**. Write it in your notes. You type it one time in step 6, so Claude can connect.

## Step 3: Buy the server

1. Click the **Deploy on Hostinger** button at the top of this page.
2. Scroll down to the plan cards. On the first card, **KVM 1**, click **Choose plan**. KVM 1 is the smallest plan and is more than enough. (You do not need the purple "Most popular" plan.)
3. In the cart:
   - **Period:** any length you want.
   - **Daily auto-backup:** not needed.
   - **Server location:** the one closest to you.
4. Click **Continue** and pay.

## Step 4: Put in your key and password

After checkout, Hostinger sets up the server and opens **Docker Manager** with this project.

1. If Hostinger asks for an **Application name**, type `fub-mcp`.
2. Find the box named **Environment**. It is below the long code box, so scroll down. If you do not see it, click the **.yaml editor** tab first.
3. Type these 2 lines in the Environment box. Use your own key and password, with no spaces:

   ```
   FUB_API_KEY=paste-your-key-here
   MCP_AUTH_PASSWORD=your-password-here
   ```

4. Click **Deploy**.
5. Wait until the status says **Running**.

Do not click **Deploy Traefik** if Hostinger shows it. This project already has HTTPS built in, and Traefik stops it from working.

## Step 5: Find your server address

At the top of the Docker Manager page, look for a name like `srv123456.hstgr.cloud`. That is your server address. Write it in your notes.

## Step 6: Connect Claude

1. Go to [claude.ai](https://claude.ai). Click your name at the bottom left, then click **Settings**.
2. Under **Customize**, click **Connectors**.
3. Click **+ Add**, then **Add custom connector**.
4. **Name:** `Follow Up Boss`
5. **MCP server URL:** `https://` + your server address + `/mcp`. Example: `https://srv123456.hstgr.cloud/mcp`
6. Click **Continue**, then finish the next screen.
7. A page named **Follow Up Boss MCP** opens. Type your password from step 2 and click **Authorize**.

The first connection can take up to 30 seconds while your server gets its free HTTPS certificate.

## Step 7: Try it

Ask Claude: *"How many people are in my Follow Up Boss?"*

## Good to know

- **Delete is off.** Claude can read, add and change, but cannot delete. To allow delete, add the line `FUB_SAFE_MODE=false` in the Environment box and click Deploy again.
- **Wrong passwords lock out.** After 5 wrong tries, that device must wait 15 minutes.
- **Claude on your phone:** the connector you add on claude.ai also works in the Claude phone app.
- **Your own domain (optional):** point the domain at your server, add `DOMAIN=fub.yourdomain.com` in the Environment box, click Deploy again, and use `https://fub.yourdomain.com/mcp` in Claude.
