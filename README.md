# Follow Up Boss MCP Server

Connect your Follow Up Boss CRM to Claude AI (or any MCP-compatible tool) with full access to all 152 official API endpoints.

> **WARNING: This tool has full read AND write access to your Follow Up Boss account.** It can create, update, and **delete** contacts, deals, tasks, notes, and other data in your CRM. Use at your own risk. We strongly recommend testing with a small number of records first, and always reviewing AI-suggested actions before confirming changes to your live data. The authors are not responsible for any data loss or unintended modifications to your FUB account.

## What This Does

This server acts as a bridge between your Follow Up Boss account and AI tools like Claude. Once connected, you can talk to Claude in plain English and it will read, create, update, and manage your FUB data directly.

**What you can do:**

- **Contacts & People** -- Search contacts, create new leads, update stages, manage tags, check duplicates, view relationships
- **Deals & Pipeline** -- Create and manage deals, move them through pipeline stages, track values and closing dates
- **Tasks & Appointments** -- Create follow-up tasks, schedule appointments, set reminders, track outcomes
- **Communication** -- View call logs, text message history, send texts through the API
- **Email Templates** -- Create, edit, and merge email templates with contact data
- **Smart Lists & Action Plans** -- View smart lists, assign people to action plans and automations
- **Custom Fields** -- Create and manage custom fields for contacts and deals
- **Teams, Groups & Ponds** -- Manage team structure, round robin groups, and lead ponds
- **Webhooks** -- Set up and manage webhook integrations
- **And more** -- Inbox apps, reactions, threaded replies, email marketing campaigns, timeframes

## What You'll Need

1. **A Follow Up Boss account** with API access (most paid plans include this)
2. **Claude Desktop**, **Claude Code**, or any MCP-compatible AI tool
3. **Node.js 18 or higher** -- This is a free tool that runs JavaScript. If you don't have it, download it from [nodejs.org](https://nodejs.org/) (choose the LTS version)

## Setup (5 Minutes)

### Step 1: Get Your FUB API Key

Your API key is like a password that lets this server talk to your FUB account.

1. Log into [Follow Up Boss](https://app.followupboss.com)
2. Go to **Admin** (top menu) > **API**
3. Copy your API key (it looks like a long string of letters and numbers)

### Step 2: Download & Install

**If you know git:**

```bash
git clone https://github.com/mindwear-capitian/followupboss-mcp-server.git
cd followupboss-mcp-server
npm install
```

**If you don't know git:**

1. Click the green **"Code"** button at the top of this page
2. Select **"Download ZIP"**
3. Unzip the downloaded file
4. Open Terminal (Mac) or Command Prompt (Windows)
5. Navigate to the unzipped folder:
   ```bash
   cd path/to/followupboss-mcp-server
   ```
6. Install dependencies:
   ```bash
   npm install
   ```

### Step 3: Run Setup

```bash
npm run setup
```

This will:
- Ask for your API key
- Test the connection to make sure it works
- **Ask you to choose Safe Mode or Full Access**
- Save your settings in a local `.env` file
- Show you exactly how to connect it to Claude

#### Safe Mode vs Full Access

| | Safe Mode (default) | Full Access |
|---|---|---|
| Read data (contacts, deals, etc.) | Yes | Yes |
| Create new records | Yes | Yes |
| Update existing records | Yes | Yes |
| **Delete records** | **No** | Yes |
| Tools available | 129 | 152 |

**Safe Mode is the default** and recommended for most users. It gives you everything except the ability to delete data. You can switch modes at any time by changing `FUB_SAFE_MODE` in your `.env` file or AI tool config.

### Step 4: Connect to Your AI Tool

Pick the tool you use below. Each one needs a small config file edit -- the setup wizard (`npm run setup`) will show you the exact paths and JSON for your computer, but here are the manual instructions for each.

> **What's a config file?** It's a settings file that tells your AI tool where to find this server. You'll copy/paste a small block of text into it. That's it.

---

#### Claude Desktop

1. Open Finder (Mac) or File Explorer (Windows)
2. Go to this file:
   - **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
3. If the file doesn't exist, create it
4. Paste this (replace the two placeholder values with yours):

```json
{
  "mcpServers": {
    "followupboss": {
      "command": "node",
      "args": ["/full/path/to/followupboss-mcp-server/index.js"],
      "env": {
        "FUB_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

5. Replace `/full/path/to/` with where you downloaded this project
6. Replace `your_api_key_here` with your FUB API key
7. **Restart Claude Desktop** (fully quit and reopen)

---

#### Claude Code (CLI)

Run this one command in your terminal (replace the path):

```bash
claude mcp add followupboss -- node /full/path/to/followupboss-mcp-server/index.js
```

Then restart Claude Code.

---

#### Cursor

1. Open Cursor
2. Go to **Settings** > **Developer** > click **"Edit Config"** (this opens `~/.cursor/mcp.json`)
3. Paste this:

```json
{
  "mcpServers": {
    "followupboss": {
      "command": "node",
      "args": ["/full/path/to/followupboss-mcp-server/index.js"],
      "env": {
        "FUB_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

4. Replace the path and API key with yours
5. **Restart Cursor**

---

#### Windsurf

1. Open Windsurf
2. Go to **Settings** > **Cascade** > **MCP Servers**
3. Or manually edit this file:
   - **Mac:** `~/.codeium/windsurf/mcp_config.json`
   - **Windows:** `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
4. Paste this:

```json
{
  "mcpServers": {
    "followupboss": {
      "command": "node",
      "args": ["/full/path/to/followupboss-mcp-server/index.js"],
      "env": {
        "FUB_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

5. Replace the path and API key with yours
6. **Fully quit and restart Windsurf**

---

#### VS Code with GitHub Copilot

> Requires VS Code 1.99 or newer and GitHub Copilot extension.

1. Open VS Code
2. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows)
3. Type **"MCP: Open User Configuration"** and select it
4. Paste this:

```json
{
  "servers": {
    "followupboss": {
      "type": "stdio",
      "command": "node",
      "args": ["/full/path/to/followupboss-mcp-server/index.js"],
      "env": {
        "FUB_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

5. Replace the path and API key with yours
6. Use the tools in Copilot's **Agent mode**

> **Note:** VS Code uses `"servers"` and requires `"type": "stdio"` -- slightly different from the other tools.

---

#### Cline (VS Code Extension)

1. Open VS Code with Cline installed
2. Click the **MCP Servers** icon in the Cline sidebar
3. Click **"Configure MCP Servers"**
4. Paste this:

```json
{
  "mcpServers": {
    "followupboss": {
      "command": "node",
      "args": ["/full/path/to/followupboss-mcp-server/index.js"],
      "env": {
        "FUB_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

5. Replace the path and API key with yours

---

#### Gemini CLI (Google)

> This works with Google's Gemini CLI tool, not the Gemini website.

1. Edit (or create) this file:
   - **Mac:** `~/.gemini/settings.json`
   - **Windows:** `%USERPROFILE%\.gemini\settings.json`
2. Paste this:

```json
{
  "mcpServers": {
    "followupboss": {
      "command": "node",
      "args": ["/full/path/to/followupboss-mcp-server/index.js"],
      "env": {
        "FUB_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

3. Replace the path and API key with yours

---

#### Continue.dev (VS Code Extension)

1. In your project, create a folder called `.continue/mcpServers/` if it doesn't exist
2. Create a file called `followupboss.json` inside it
3. Paste this:

```json
{
  "mcpServers": {
    "followupboss": {
      "command": "node",
      "args": ["/full/path/to/followupboss-mcp-server/index.js"],
      "env": {
        "FUB_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

4. Replace the path and API key with yours
5. Use the tools in Continue's **Agent mode**

---

#### ChatGPT, OpenAI API, and Grok

These tools only support **remote** MCP servers (hosted on the internet), not local ones. This means the setup is more advanced -- you would need to host this server on a cloud service with HTTPS.

If there's enough interest, we may add a hosted version in the future. For now, we recommend using one of the tools listed above that support local MCP servers.

## Usage Examples

Once connected, just talk to your AI tool normally. Here are some things you can ask:

> "Show me all my leads from this week"

> "Create a task to follow up with John Smith tomorrow at 2pm"

> "What deals do I have in my pipeline over $500k?"

> "Add a note to Jane Doe's profile: Had a great phone call, she's interested in the Oak Park listing"

> "List all my upcoming appointments for this week"

> "Who are my uncontacted leads?"

> "Move the Smith deal to the 'Under Contract' stage"

> "Show me all contacts tagged 'hot lead'"

> "Create a new email template called 'Open House Follow Up'"

> "What action plans do I have set up?"

## All 152 Available Tools

<details>
<summary>Click to expand full tool list</summary>

### Events (3 tools)
| Tool | Description |
|------|-------------|
| `listEvents` | List events with filtering by person, type, property |
| `createEvent` | Create a new event (lead event, property inquiry, etc.) |
| `getEvent` | Get a single event by ID |

### People / Contacts (8 tools)
| Tool | Description |
|------|-------------|
| `listPeople` | Search and filter contacts extensively |
| `createPerson` | Create a new contact |
| `getPerson` | Get a contact by ID |
| `updatePerson` | Update contact details, stage, tags, etc. |
| `deletePerson` | Delete (trash) a contact |
| `checkDuplicate` | Check if a contact exists by email or phone |
| `listUnclaimed` | List unclaimed leads in ponds |
| `claimPerson` | Claim an unclaimed lead |

### Person Attachments (4 tools)
| Tool | Description |
|------|-------------|
| `createPersonAttachment` | Attach a file to a contact |
| `getPersonAttachment` | Get an attachment by ID |
| `updatePersonAttachment` | Update an attachment |
| `deletePersonAttachment` | Delete an attachment |

### Relationships (5 tools)
| Tool | Description |
|------|-------------|
| `listRelationships` | List relationships for a contact |
| `createRelationship` | Create a relationship between two contacts |
| `getRelationship` | Get a relationship by ID |
| `updateRelationship` | Update a relationship |
| `deleteRelationship` | Delete a relationship |

### Identity (2 tools)
| Tool | Description |
|------|-------------|
| `getIdentity` | Get account information for the API key |
| `getCurrentUser` | Get the current authenticated user |

### Notes (4 tools)
| Tool | Description |
|------|-------------|
| `createNote` | Create a note on a contact |
| `getNote` | Get a note by ID |
| `updateNote` | Update a note |
| `deleteNote` | Delete a note |

### Calls (4 tools)
| Tool | Description |
|------|-------------|
| `listCalls` | List call records |
| `createCall` | Log a call |
| `getCall` | Get a call by ID |
| `updateCall` | Update a call record |

### Text Messages (3 tools)
| Tool | Description |
|------|-------------|
| `listTextMessages` | List text messages |
| `createTextMessage` | Send a text message |
| `getTextMessage` | Get a text message by ID |

### Users (3 tools)
| Tool | Description |
|------|-------------|
| `listUsers` | List all users/agents |
| `getUser` | Get a user by ID |
| `deleteUser` | Delete a user |

### Smart Lists (2 tools)
| Tool | Description |
|------|-------------|
| `listSmartLists` | List all smart lists |
| `getSmartList` | Get a smart list by ID |

### Action Plans (4 tools)
| Tool | Description |
|------|-------------|
| `listActionPlans` | List all action plans |
| `listActionPlansPeople` | List people in action plans |
| `addPersonToActionPlan` | Add a contact to an action plan |
| `updateActionPlanPerson` | Update action plan status for a contact |

### Automations (6 tools)
| Tool | Description |
|------|-------------|
| `listAutomations` | List all automations |
| `getAutomation` | Get an automation by ID |
| `listAutomationsPeople` | List people in automations |
| `getAutomationPerson` | Get automation-person entry |
| `addPersonToAutomation` | Add a contact to an automation |
| `updateAutomationPerson` | Update automation status for a contact |

### Email Templates (6 tools)
| Tool | Description |
|------|-------------|
| `listTemplates` | List email templates |
| `createTemplate` | Create an email template |
| `getTemplate` | Get a template by ID |
| `updateTemplate` | Update a template |
| `mergeTemplate` | Merge template with contact data (mail merge) |
| `deleteTemplate` | Delete a template |

### Text Message Templates (6 tools)
| Tool | Description |
|------|-------------|
| `listTextMessageTemplates` | List text message templates |
| `createTextMessageTemplate` | Create a text message template |
| `getTextMessageTemplate` | Get a template by ID |
| `updateTextMessageTemplate` | Update a template |
| `mergeTextMessageTemplate` | Merge template with contact data |
| `deleteTextMessageTemplate` | Delete a template |

### Email Marketing (5 tools)
| Tool | Description |
|------|-------------|
| `listEmEvents` | List email marketing events |
| `createEmEvent` | Create email marketing events |
| `listEmCampaigns` | List email marketing campaigns |
| `createEmCampaign` | Create a campaign |
| `updateEmCampaign` | Update a campaign |

### Custom Fields (5 tools)
| Tool | Description |
|------|-------------|
| `listCustomFields` | List all custom fields |
| `createCustomField` | Create a custom field |
| `getCustomField` | Get a custom field by ID |
| `updateCustomField` | Update a custom field |
| `deleteCustomField` | Delete a custom field |

### Stages (5 tools)
| Tool | Description |
|------|-------------|
| `listStages` | List all pipeline stages |
| `createStage` | Create a stage |
| `getStage` | Get a stage by ID |
| `updateStage` | Update a stage |
| `deleteStage` | Delete a stage |

### Tasks (5 tools)
| Tool | Description |
|------|-------------|
| `listTasks` | List tasks |
| `createTask` | Create a task |
| `getTask` | Get a task by ID |
| `updateTask` | Update a task |
| `deleteTask` | Delete a task |

### Appointments (5 tools)
| Tool | Description |
|------|-------------|
| `listAppointments` | List appointments |
| `createAppointment` | Create an appointment |
| `getAppointment` | Get an appointment by ID |
| `updateAppointment` | Update an appointment |
| `deleteAppointment` | Delete an appointment |

### Appointment Types (5 tools)
| Tool | Description |
|------|-------------|
| `listAppointmentTypes` | List appointment types |
| `createAppointmentType` | Create a type |
| `getAppointmentType` | Get a type by ID |
| `updateAppointmentType` | Update a type |
| `deleteAppointmentType` | Delete a type |

### Appointment Outcomes (5 tools)
| Tool | Description |
|------|-------------|
| `listAppointmentOutcomes` | List outcomes |
| `createAppointmentOutcome` | Create an outcome |
| `getAppointmentOutcome` | Get an outcome by ID |
| `updateAppointmentOutcome` | Update an outcome |
| `deleteAppointmentOutcome` | Delete an outcome |

### Webhooks (6 tools)
| Tool | Description |
|------|-------------|
| `listWebhooks` | List all webhooks |
| `createWebhook` | Create a webhook |
| `getWebhook` | Get a webhook by ID |
| `updateWebhook` | Update a webhook |
| `deleteWebhook` | Delete a webhook |
| `getWebhookEvents` | Get events for a webhook |

### Pipelines (5 tools)
| Tool | Description |
|------|-------------|
| `listPipelines` | List all pipelines |
| `createPipeline` | Create a pipeline |
| `getPipeline` | Get a pipeline by ID |
| `updatePipeline` | Update a pipeline |
| `deletePipeline` | Delete a pipeline |

### Deals (5 tools)
| Tool | Description |
|------|-------------|
| `listDeals` | List deals with filtering |
| `createDeal` | Create a deal |
| `getDeal` | Get a deal by ID |
| `updateDeal` | Update a deal |
| `deleteDeal` | Delete a deal |

### Deal Attachments (4 tools)
| Tool | Description |
|------|-------------|
| `createDealAttachment` | Attach a file to a deal |
| `getDealAttachment` | Get an attachment by ID |
| `updateDealAttachment` | Update an attachment |
| `deleteDealAttachment` | Delete an attachment |

### Deal Custom Fields (5 tools)
| Tool | Description |
|------|-------------|
| `listDealCustomFields` | List deal custom fields |
| `createDealCustomField` | Create a deal custom field |
| `getDealCustomField` | Get a field by ID |
| `updateDealCustomField` | Update a field |
| `deleteDealCustomField` | Delete a field |

### Groups (6 tools)
| Tool | Description |
|------|-------------|
| `listGroups` | List all groups |
| `listRoundRobinGroups` | List round robin groups |
| `createGroup` | Create a group |
| `getGroup` | Get a group by ID |
| `updateGroup` | Update a group |
| `deleteGroup` | Delete a group |

### Teams (5 tools)
| Tool | Description |
|------|-------------|
| `listTeams` | List all teams |
| `createTeam` | Create a team |
| `getTeam` | Get a team by ID |
| `updateTeam` | Update a team |
| `deleteTeam` | Delete a team |

### Team Inboxes (1 tool)
| Tool | Description |
|------|-------------|
| `listTeamInboxes` | List all team inboxes |

### Ponds (5 tools)
| Tool | Description |
|------|-------------|
| `listPonds` | List all ponds |
| `createPond` | Create a pond |
| `getPond` | Get a pond by ID |
| `updatePond` | Update a pond |
| `deletePond` | Delete a pond |

### Timeframes (1 tool)
| Tool | Description |
|------|-------------|
| `listTimeframes` | List all timeframes |

### Inbox Apps (10 tools)
| Tool | Description |
|------|-------------|
| `inboxAppAddMessage` | Add a message to a conversation |
| `inboxAppUpdateMessage` | Update a message |
| `inboxAppAddNote` | Add a note to a conversation |
| `inboxAppUpdateConversation` | Update conversation status |
| `inboxAppGetParticipants` | Get conversation participants |
| `inboxAppCreateParticipant` | Add a participant |
| `inboxAppDeleteParticipant` | Remove a participant |
| `inboxAppInstall` | Install an inbox app |
| `inboxAppDeactivate` | Deactivate the inbox app |
| `listInboxAppInstallations` | List installations |

### Reactions (3 tools)
| Tool | Description |
|------|-------------|
| `getReactions` | Get reactions for an item |
| `createReaction` | Add a reaction |
| `deleteReaction` | Remove a reaction |

### Threaded Replies (1 tool)
| Tool | Description |
|------|-------------|
| `getThreadedReplies` | Get threaded replies for an item |

</details>

## Troubleshooting

**"Cannot connect" or "Connection refused"**
- Make sure Node.js is installed: run `node --version` in your terminal (should show v18 or higher)
- Make sure you ran `npm install` in the project folder
- Double-check the file path in your Claude config

**"Invalid API key" or "401 Unauthorized"**
- Re-check your API key in FUB: Admin > API
- Make sure there are no extra spaces when you copy/paste
- Run `npm run setup` again to test your key

**"Tool not found" in Claude**
- Restart Claude Desktop after adding the server config
- Check that the JSON in your config file is valid (no missing commas or brackets)

**Claude doesn't seem to know about FUB**
- Make sure the server name in your config matches exactly
- Check Claude Desktop's developer console for error messages
- Try asking Claude: "What MCP tools do you have available?"

## FAQ

**Is my data safe?**

Yes. This server runs entirely on your computer. Your API key stays in a local file on your machine and is never sent anywhere except directly to Follow Up Boss's official API. No data passes through any third-party servers.

**Does this cost anything?**

This server is free and open source. You just need a Follow Up Boss account with API access (included in most paid plans).

**Can Claude modify my FUB data?**

Yes, Claude can create, update, and delete records in your FUB account. Claude will typically confirm before making changes, especially for deletions. If you want read-only access, you can create a restricted API key in FUB.

**What's MCP?**

MCP (Model Context Protocol) is an open standard created by Anthropic that lets AI tools like Claude connect to external services. Think of it as a universal plug that lets Claude talk to your apps. [Learn more about MCP](https://modelcontextprotocol.io/).

**Who made this?**

Built by [Ed Neuhaus](https://neuhausre.com/agent/ed-neuhaus/), broker at [Neuhaus Realty Group](https://neuhausre.com) and creator of [StaySTRA](https://staystra.com), both in Austin, TX. We use Follow Up Boss every day and built this to make our own workflow faster.

## Contributing

Contributions are welcome! Here's how:

1. Fork this repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes
4. Test them: `node -c index.js` (syntax check)
5. Commit: `git commit -m "Add my feature"`
6. Push: `git push origin my-feature`
7. Open a Pull Request

Please keep the code style consistent and make sure all 152 tools continue to work.

## License

MIT -- see [LICENSE](LICENSE) for details.

---

Built by [Ed Neuhaus](https://neuhausre.com/agent/ed-neuhaus/) / [StaySTRA](https://staystra.com)
