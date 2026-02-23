#!/usr/bin/env node

/**
 * Follow Up Boss MCP Server - Setup Wizard
 *
 * Interactive setup that:
 * 1. Asks for your FUB API key
 * 2. Creates a .env file
 * 3. Tests the connection
 * 4. Shows next steps
 */

import { createInterface } from 'readline';
import { writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function testConnection(apiKey) {
  // Dynamic import to avoid issues if axios isn't installed yet
  const { default: axios } = await import('axios');

  const response = await axios.get('https://api.followupboss.com/v1/me', {
    auth: { username: apiKey, password: '' },
    headers: { 'Accept': 'application/json' },
    timeout: 10000,
  });

  return response.data;
}

async function main() {
  console.log('');
  console.log('===========================================');
  console.log('  Follow Up Boss MCP Server - Setup');
  console.log('===========================================');
  console.log('');
  console.log('This will set up your connection to Follow Up Boss.');
  console.log('You\'ll need your FUB API key.');
  console.log('');
  console.log('To find it: Log into FUB > Admin > API > copy your API key');
  console.log('');

  const apiKey = await ask('Enter your FUB API key: ');

  if (!apiKey) {
    console.log('\nNo API key entered. Setup cancelled.');
    rl.close();
    process.exit(1);
  }

  console.log('\nTesting connection...');

  try {
    const user = await testConnection(apiKey);
    const name = user.name || user.firstName || 'Unknown';
    const account = user.accountName || user.account?.name || '';

    console.log('');
    console.log('  Connected successfully!');
    if (name) console.log(`  User: ${name}`);
    if (account) console.log(`  Account: ${account}`);
    console.log('');
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('\nInvalid API key. Please check your key and try again.');
      console.log('Find it at: FUB > Admin > API');
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.log('\nCould not connect to Follow Up Boss. Check your internet connection.');
    } else {
      console.log(`\nConnection failed: ${error.message}`);
    }
    rl.close();
    process.exit(1);
  }

  // Safe mode question
  console.log('Choose an installation mode:');
  console.log('');
  console.log('  1. Safe Mode (recommended)');
  console.log('     Read, create, and update your FUB data.');
  console.log('     Delete tools are DISABLED. Nothing can be deleted.');
  console.log('');
  console.log('  2. Full Access');
  console.log('     All 152 tools enabled, including delete operations.');
  console.log('     Use with caution -- AI can delete contacts, deals, etc.');
  console.log('');
  const modeChoice = await ask('Enter 1 or 2 (default: 1): ');
  const safeMode = modeChoice !== '2';

  if (safeMode) {
    console.log('\n  Safe Mode enabled. Delete tools will be disabled.');
  } else {
    console.log('\n  Full Access enabled. All tools including delete are active.');
  }
  console.log('');

  // Write .env file
  const envPath = resolve(__dirname, '.env');
  const envExists = existsSync(envPath);

  if (envExists) {
    const overwrite = await ask('.env file already exists. Overwrite? (y/n): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\nSetup complete (kept existing .env file).');
      rl.close();
      printNextSteps(safeMode);
      return;
    }
  }

  writeFileSync(envPath, `# Follow Up Boss API Key\nFUB_API_KEY=${apiKey}\n\n# Safe Mode: disable all delete tools (true/false)\nFUB_SAFE_MODE=${safeMode}\n`);
  console.log('Saved settings to .env file.');

  rl.close();
  printNextSteps(safeMode);
}

function printNextSteps(safeMode) {
  const fullPath = resolve(__dirname);

  const envBlock = { FUB_API_KEY: "your_api_key_here" };
  if (safeMode) envBlock.FUB_SAFE_MODE = "true";

  console.log('');
  console.log('===========================================');
  console.log('  Next Steps: Connect to Claude');
  console.log('===========================================');
  console.log('');
  console.log(`Mode: ${safeMode ? 'SAFE MODE (delete tools disabled)' : 'FULL ACCESS (all tools enabled)'}`);
  console.log('');
  console.log('OPTION 1: Claude Desktop');
  console.log('');
  console.log('Add this to your Claude Desktop config file:');
  console.log('');
  console.log('  Mac:   ~/Library/Application Support/Claude/claude_desktop_config.json');
  console.log('  Win:   %APPDATA%\\Claude\\claude_desktop_config.json');
  console.log('');
  console.log(JSON.stringify({
    mcpServers: {
      "followupboss": {
        command: "node",
        args: [`${fullPath}/index.js`],
        env: envBlock
      }
    }
  }, null, 2));
  console.log('');
  console.log('(Replace "your_api_key_here" with your actual API key,');
  console.log(' or remove the env block if you\'re using the .env file)');
  console.log('');
  console.log('OPTION 2: Claude Code');
  console.log('');
  console.log(`  claude mcp add followupboss node ${fullPath}/index.js`);
  console.log('');
  console.log('Then restart Claude and try asking:');
  console.log('  "Show me my recent leads in Follow Up Boss"');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
