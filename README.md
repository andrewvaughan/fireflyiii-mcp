# MCP server for Firefly III

[![npm version](https://img.shields.io/npm/v/@daften/fireflyiii-mcp.svg)](https://www.npmjs.com/package/@daften/fireflyiii-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@daften/fireflyiii-mcp.svg)](https://www.npmjs.com/package/@daften/fireflyiii-mcp)
[![CI](https://github.com/daften/fireflyiii-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/daften/fireflyiii-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Documentation](https://img.shields.io/badge/docs-daften.github.io-blue)](https://daften.github.io/fireflyiii-mcp/)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects any MCP-compatible AI assistant to your [Firefly III](https://www.firefly-iii.org) personal finance instance. Ask your AI assistant questions about your finances in natural language.

📖 **[Full documentation → daften.github.io/fireflyiii-mcp](https://daften.github.io/fireflyiii-mcp/)**

## What this fork changes

This is Andrew Vaughan's fork of [daften/fireflyiii-mcp](https://github.com/daften/fireflyiii-mcp), used by a household AI agent that keeps the family's Firefly III books. It is built from source and nothing here is published to npm. The `household` branch is upstream release v0.5.5 (commit `4316a86`) plus the household commits, and every change is marked "Household fork" in the source. It was rebased from v0.5.3 on 2026-10-22, when upstream's two releases changed only dependencies (v0.5.5 moves the transitive `hono` to 4.13.13 for GHSA-5r4p-p66f-jhc7); the v0.5.3 build is kept as the tag `household-v0.5.3`.

| Change | Why | Files |
|---|---|---|
| `update_transaction` reads the entry first, edits one named line (`transaction_journal_id`, required when the entry has several lines), and sends every other line back by its id | Firefly deletes every line of an entry that a PUT leaves out. Upstream sent one line with no id, so editing a split entry deleted its other lines (the same class of loss that removed 46 mortgage interest lines from these books on 2026-10-10) | `src/tools/transactions.ts` (`updateTransaction`, `fetchJournals`) |
| A tag list sent to `update_transaction` or `split_transaction` without a "Source: " tag keeps the line's own Source tags | Every entry in these books carries a Source tag saying where it came from, and a replacing tag list that left it out dropped it (an earlier split script lost five) | `src/tools/transactions.ts` (`keepSourceTags`) |
| New `split_transaction` tool: divides an existing entry into item lines that must add up to its total to the cent, reusing existing lines (same amount first, then in order) and refusing to remove a line that holds an attachment; a new line takes the tags and book date of the entry's first line | Receipts divide one card charge into items in different categories. Upstream could only do that by creating a new transaction, which these books never do from a receipt. A new line with no tags lost the Source tag, and one with no book date counted on the wrong day against the bank's statement | `src/tools/transactions.ts` (`splitTransaction`) |
| `bulk_update_transactions` finds lines with Firefly's search and edits each entry the way `update_transaction` does, adding and removing tags (`add_tags`, `remove_tags`) instead of replacing them, with `dry_run` and `max_entries` (default 25, skipping lines already changed so a second call continues) | Firefly's `/data/bulk/transactions` only moves every entry from one account to another and refused upstream's search query, so the tool never changed anything; and upstream's `tags` replaced each entry's tags | `src/tools/transactions.ts` (`bulkUpdateTransactions`) |
| `create_recurring` defaults `apply_rules` to false | Like every other agent write, so Firefly's rules do not rewrite generated entries unless the agent asks | `src/tools/recurring.ts` |
| `create_transaction`, `create_split_transaction`, `update_transaction` and `split_transaction` send `apply_rules: false` | So Firefly's rules cannot rewrite the category, description or tags the agent has just set | `src/tools/transactions.ts` (`APPLY_RULES`) |
| `delete_account` refuses an account that still has entries | Firefly deletes every entry on an account together with the account | `src/tools/accounts.ts` (`deleteAccount`) |
| `create_transaction` and `update_transaction` take `book_date` | A transfer between two of the household's accounts often reaches the receiving one on another day, and each account matches its statement only with both dates; Firefly stores the second as `book_date`, which upstream's tools did not expose | `src/tools/transactions.ts` (`BOOK_DATE_HINT`) |
| `delete_transaction` reads the entry first, refuses one the bank import (external id `ff3-`) brought in during the last 8 days, and returns the lines, amounts, dates and external ids it removed | The nightly import looks back 7 days and re-creates any entry it cannot find, so such a delete would come back; and the agent reports exactly what it deleted | `src/tools/transactions.ts` (`deleteTransaction`, `IMPORT_WINDOW_DAYS`) |
| The Firefly request timeout comes from `FIREFLY_REQUEST_TIMEOUT_MS` (default 30 s, unchanged) | With running balances on, writing an old entry recalculates every later entry on the account: 30 to 33 s for a 2023 entry (2026-10-18), so the agent saw a timeout for a write Firefly then saved | `src/client.ts` (`requestTimeoutMs`) |
| `create_transaction` and `create_split_transaction` send `error_if_duplicate_hash: true` | A create can time out after Firefly has saved it (one write did on 2026-10-16), and an agent that retries would enter the same money twice; Firefly refuses an exact duplicate instead | `src/tools/transactions.ts` (`DUPLICATE_GUARD`) |
| `upload_attachment` also accepts `file_path`, read only from folders listed in `FIREFLY_MCP_UPLOAD_PATHS` (off when unset), through the file's resolved path | A tool argument cannot carry a real PDF as base64, and a receipt has to be attached from a file. Reading the resolved path means a symlink cannot be swapped in after the check | `src/tools/attachments.ts` (`readUploadFile`) |

Since 2026-10-18 the household agent with write access holds every tool (Andrew: the amount refusal is gone and nothing is filtered out); each write still waits for a person's approval in the agent's own workflow.

Tests: `src/tests/transactions.test.ts` (the "household fork" suites), `src/tests/attachments.test.ts` (`readUploadFile`), and the tool counts in `src/tests/tool-filter.test.ts`, one higher in every preset that includes transactions.

### Rebasing onto a new upstream release

1. Fetch upstream and read its changelog, then its diff from `4316a86` (v0.5.5) for `src/tools/transactions.ts`, `src/tools/attachments.ts` and the tests above.
2. Drop any change upstream now covers: check whether `update_transaction` sends `transaction_journal_id` and keeps other lines, whether writes still send `apply_rules: true`, whether creates send `error_if_duplicate_hash`, whether a tool divides an existing entry, whether `upload_attachment` takes a file path, and whether `bulk_update_transactions` works against Firefly's bulk endpoint and keeps tags.
3. Rebase the `household` branch onto the release, resolve conflicts, then run `npm ci` and `npm run check`. Update the tool counts if upstream added tools.
4. Review the new commit, then point the deployment at it.

## What you can ask

Once configured, you can ask things like:

- *"How much did I spend on groceries last month?"*
- *"Show me my budget status for this month."*
- *"Find any duplicate transactions in the last 30 days."*
- *"Set up a piggy bank for my vacation fund with a €2000 target."*
- *"What were my biggest expense categories this year?"*

Your AI assistant handles the Firefly III API calls — you get answers in plain language.

---

Choose your setup method:

| Method | Transport | Best for |
|--------|-----------|----------|
| [npm — stdio](#option-1-npm-package--stdio-simplest) | stdio | Simplest setup, AI on the same machine |
| [npm — HTTP](#option-2-npm-package--http-oauth-or-pat) | HTTP + OAuth or PAT | Remote AI access, or a headless gateway with no browser in the loop |
| [Docker — HTTP](#option-3-docker--http-self-hosted) | HTTP + OAuth or PAT | Self-hosted on a server or home lab |
| [Git checkout](#option-4-git-checkout-development) | stdio or HTTP | Contributing or local development |

All options except Docker require **Node.js 22.12+**.

---

## Option 1: npm package — stdio (simplest)

**Requires:** Node.js 22.12+, a Firefly III Personal Access Token (Options → Remote access and tokens → Create new token).

Add to your Claude MCP config (`.claude/mcp.json` or Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fireflyiii": {
      "command": "npx",
      "args": ["-y", "@daften/fireflyiii-mcp"],
      "env": {
        "FIREFLY_URL": "https://your-firefly-instance.example.com",
        "FIREFLY_TOKEN": "your-personal-access-token-here"
      }
    }
  }
}
```

Your MCP client downloads and starts the server automatically on first use. No separate install step needed.

**Claude Desktop users:** this stdio form is the recommended setup. Claude Desktop's config file does *not* accept HTTP servers — see the [Claude Desktop guide](https://daften.github.io/fireflyiii-mcp/guide/claude-desktop) if you need a remote setup.

---

## Option 2: npm package — HTTP (OAuth or PAT)

→ See the [HTTP/OAuth](https://daften.github.io/fireflyiii-mcp/guide/http-oauth) setup guide, or [HTTP/PAT](https://daften.github.io/fireflyiii-mcp/guide/http-pat) for headless callers (gateways, automation) that can't drive a browser-based OAuth flow.

---

## Option 3: Docker — HTTP (self-hosted)

→ See [Docker setup guide](https://daften.github.io/fireflyiii-mcp/guide/docker) in the docs.

---

## Option 4: Git checkout (development)

→ See [Git checkout guide](https://daften.github.io/fireflyiii-mcp/guide/git-checkout) in the docs.

---

## Nightly builds (unstable)

Want to test unreleased changes from `main`? A nightly build is published automatically each night that `main` has changed. **These are unstable and not recommended for production.**

- **npm:** `npm install @daften/fireflyiii-mcp@nightly` (or `npx @daften/fireflyiii-mcp@nightly`)
- **Docker:** `docker pull ghcr.io/daften/fireflyiii-mcp:nightly`

A normal install (no tag) always resolves to the latest tagged release — `@latest` on npm and `:latest` on Docker are never moved to a nightly. To go back to a stable build, reinstall without the `@nightly` / `:nightly` tag.

---

## Experimental Autocomplete Prompts

→ See [Autocomplete prompts](https://daften.github.io/fireflyiii-mcp/reference/autocomplete) in the docs.

---

## Available Tools

→ See the full [tool reference](https://daften.github.io/fireflyiii-mcp/reference/tools) in the docs (140 tools across 14 groups).

---

## Filtering Tools

→ See [Tool filtering](https://daften.github.io/fireflyiii-mcp/reference/filtering) in the docs.

---

## Development

```bash
npm test                  # Run unit tests
npm run test:watch        # Watch mode
npm run test:integration  # Run against live Firefly III (requires FIREFLY_URL + FIREFLY_TOKEN)
npm run dev               # Run without building (uses tsx)
npm run build             # Compile TypeScript to dist/
```

## Resources

- [Firefly III API Documentation](https://api-docs.firefly-iii.org/) — interactive Swagger UI for all API versions
- [Firefly III OpenAPI YAML](https://api-docs.firefly-iii.org/firefly-iii-6.5.5-v1.yaml) — machine-readable spec; fetch with `curl -s "https://api-docs.firefly-iii.org/firefly-iii-6.5.5-v1.yaml" -A "Mozilla/5.0"` (direct browser access blocked by bot protection)
- [Firefly III Docs](https://docs.firefly-iii.org/)
- [MCP Documentation](https://modelcontextprotocol.io/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, tool-add checklist, and commit conventions.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy.

## Acknowledgements

Feature comparison informed by [fabianonetto/mcp-server-firefly-iii](https://github.com/fabianonetto/mcp-server-firefly-iii) and [etnperlong/firefly-iii-mcp](https://github.com/etnperlong/firefly-iii-mcp).

## License

MIT
