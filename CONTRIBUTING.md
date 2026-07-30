# Contributing

Thanks for considering a contribution. This is a small project run by a working real estate broker, not a software company. PRs and issues are welcome — and so are typo fixes, tool description tweaks, and dumb questions.

## Quick rules

- **Be kind.** This server gets used by real people running real businesses. Don't break their data.
- **Keep it simple.** This is a single-file MCP server (`index.js`). No build step, no TypeScript. Don't introduce a build system or framework unless there's a really good reason.
- **License is Elastic License 2.0.** By submitting a PR you agree to the [Contributor license grant](#contributor-license-grant) below. If you can't agree to that, please don't submit.
- **Attribution is preserved.** Don't strip copyright or NOTICE entries. Add yours alongside if you contribute meaningful code — pile up the credit, don't replace it.

## Contributor license grant

Short version: you keep the copyright on what you write, and I get permission to actually ship it — including in paid or hosted form.

The long version, because it matters and I'd rather be clear than clever:

> By submitting a contribution to this project, you grant Ed Neuhaus (Neuhaus Realty Group LLC) a perpetual, worldwide, non-exclusive, irrevocable, royalty-free license to use, reproduce, modify, adapt, publish, distribute, sublicense, and relicense your contribution, in whole or in part, for any purpose — including commercial use, and including offering it to third parties as a hosted or managed service.
>
> You keep your copyright. This is a license, not an assignment. You can still do whatever you want with your own code elsewhere.
>
> You confirm the contribution is your original work and that you have the right to grant this license — in particular, that it isn't owned by an employer or covered by an agreement that would prevent you from contributing it.
>
> Your contribution is also published to the public under the Elastic License 2.0, same as the rest of the repo.

Why this exists: the repo is ELv2, which stops *anyone* from offering it as a hosted or managed service. Without a separate grant, that same restriction would ride along on contributed code — so a handful of donated lines could block the project's own maintainer from running a hosted version. This paragraph fixes that. Nothing changes for you as a user or a self-hoster: self-hosting is free and always will be.

## Reporting bugs

Open an issue at https://github.com/mindwear-capitian/followupboss-mcp-server/issues with:

- What you tried (the natural-language thing you asked Claude)
- What you expected
- What actually happened
- Tool name and arguments if you can capture them
- Your FUB plan / role if relevant (some endpoints differ by plan)

If the bug exposes data or has a security impact, see [SECURITY.md](SECURITY.md) instead.

## Submitting a fix or feature

1. Fork the repo
2. Create a branch (`git checkout -b fix/listSmartLists-something`)
3. Make your changes in `index.js`
4. Sanity check: `node -c index.js` (syntax) and `npm test` (basic startup test)
5. Commit with a message that explains the **why**, not just the **what**
6. Push and open a Pull Request

If you've found and fixed a bug in your own fork without going through a PR, that's also fine — open an issue describing what you fixed and link to your fork commit. I'll port it back and credit you in the commit + NOTICE. (See yoship90's smart list fix in v1.1.2 as the template.)

## Code style

- Match what's already there. No prettier config. Two-space indents. ES modules.
- Tool definitions live in the `TOOL_DEFINITIONS` array. Tool dispatchers live in the `handleToolCall` switch. Keep them in the same logical section so they're easy to find together.
- New tools should have clear `description` text — that text is what tells AI clients when to call your tool. Write it like a prompt, not a code comment.

## Things I will probably push back on

- Adding a build step or framework
- Adding telemetry / phone-home / "anonymous usage tracking"
- Adding paid-tier feature gates inside the open source code
- Replacing axios with another HTTP client just because
- Refactoring for the sake of refactoring

## Things I'd love to see

- Bug fixes (especially silent-failure ones)
- New convenience tools that wrap common multi-step workflows
- Better error messages with links to relevant FUB docs
- Documentation improvements
- Translations of the README

## Not a contribution but still welcome

- Real estate referrals from licensed agents anywhere in the US, for clients moving to or from Texas. Reach out via [neuhausre.com/contact](https://neuhausre.com/contact).
- A blog post about how you use this tool, with a link back to the repo.
- Questions in [Discussions](https://github.com/mindwear-capitian/followupboss-mcp-server/discussions) — even basic ones. They help other realtors who are trying to figure this out.

— Ed
