# Security Policy

## Scope

This server provides full read/write/delete access to a Follow Up Boss CRM account using the user's own API key. It runs locally on the user's machine (or self-hosted server) and never sends data to anywhere except `api.followupboss.com`. There is no central service, no telemetry, no analytics.

That said, anything that runs against a real CRM with real client data is worth taking seriously. If you find a security issue, please report it.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Instead, report via [neuhausre.com/contact](https://neuhausre.com/contact) with the subject line "FUB MCP Security". Include:

- A description of the issue
- Steps to reproduce (or proof-of-concept)
- The version of this server you found it in (`v1.1.2`, etc.)
- Whether the issue affects existing data, future data, or just operational integrity
- Whether you've disclosed it elsewhere

I'll acknowledge within 7 days. If the issue is real, I'll work with you on a coordinated disclosure timeline — typically a fix released within 30 days, then a public advisory once users have had a chance to update.

## What counts as a vulnerability

**In scope:**

- Anything that lets an attacker read, modify, or delete FUB data they shouldn't have access to
- Anything that exposes the user's FUB API key (logs, error messages, network traffic to non-FUB destinations)
- Anything that allows arbitrary code execution via crafted tool arguments
- Bugs that cause silent data corruption (e.g., bulk operations that succeed-but-don't, or operations that affect different records than the user intended)
- Authentication bypass on FUB-side endpoints we proxy

**Not in scope:**

- The fact that this tool can delete records when given a delete tool — that's working as designed (use Safe Mode)
- Issues in Follow Up Boss's own API (report those to FUB directly)
- Issues in Anthropic's Claude or other MCP hosts (report those to the host vendor)
- Rate-limit DoS against your own FUB account
- Issues in node modules — please report those to the upstream module first

## Safe mode

The server defaults to `FUB_SAFE_MODE=true` which disables all 23 delete tools at the dispatcher level. If you don't trust the AI to delete things, leave Safe Mode on. We strongly recommend backing up your FUB data before running this against a production CRM, regardless of mode.

## Responsible disclosure credit

If you'd like credit for a valid report, you'll be added to the `NOTICE` file under Contributors with a description of your finding (or kept anonymous if you prefer). Real estate referrals from licensed agents are also welcome as a thank-you.
