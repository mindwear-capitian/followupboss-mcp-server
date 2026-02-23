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

  // Write .env file
  const envPath = resolve(__dirname, '.env');
  const envExists = existsSync(envPath);

  if (envExists) {
    const overwrite = await ask('.env file already exists. Overwrite? (y/n): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\nSetup complete (kept existing .env file).');
      rl.close();
      printNextSteps();
      return;
    }
  }

  writeFileSync(envPath, `# Follow Up Boss API Key\nFUB_API_KEY=${apiKey}\n`);
  console.log('Saved API key to .env file.');

  rl.close();
  printNextSteps();
}

function printNextSteps() {
  const fullPath = resolve(__dirname);

  console.log('');
  console.log('===========================================');
  console.log('  Next Steps: Connect to Claude');
  console.log('===========================================');
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
        env: {
          FUB_API_KEY: "your_api_key_here"
        }
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
