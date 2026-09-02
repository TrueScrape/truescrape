# TrueScrape

Public social media data from one API: profiles, posts, videos, comments,
transcripts, ad libraries and metrics across every platform in the catalogue,
in one schema. This repository holds the three ways to plug it into your
tools and your agents.

| | Install | Best for |
|---|---|---|
| **CLI** | `npm install -g truescrape` or `npx truescrape …` | Scripts, cron, CI, one-off pulls, piping into `jq` |
| **MCP server** | `claude mcp add --transport http truescrape https://api.truescrape.com/mcp --header "x-api-key: YOUR_KEY"` | Claude, Cursor, VS Code and any MCP client calling endpoints as tools |
| **Agent skill** | `npx skills add TrueScrape/truescrape` | Teaching Claude Code, Cursor, Codex, Copilot, Gemini CLI or Windsurf how to use the API well |

> The npm package is not published yet. Until it is, run the CLI from source:
> `git clone https://github.com/TrueScrape/truescrape && cd truescrape && pnpm install && pnpm build && node dist/index.js --help`.
> The skill, the plugin and the MCP server work today.

<!-- catalogue:start -->
**173 endpoints across 28 platforms**, generated from the live API on 2026-09-02.

tiktok (30) · facebook (20) · instagram (19) · youtube (17) · github (10) · linkedin (8) · reddit (8) · spotify (6) · twitter (6) · rumble (5) · threads (5) · apple-music (4) · google (4) · pinterest (4) · twitch (4) · bluesky (3) · kwai (3) · snapchat (3) · soundcloud (3) · truthsocial (3) · amazon (1) · inference (1) · kick (1) · komi (1) · linkbio (1) · linkme (1) · linktree (1) · pillar (1)
<!-- catalogue:end -->

Get a key at [truescrape.com/dashboard](https://truescrape.com/dashboard).
Docs: [truescrape.com/docs](https://truescrape.com/docs) ·
[OpenAPI](https://api.truescrape.com/openapi.json) ·
[llms.txt](https://api.truescrape.com/llms.txt)

## Three rules that change how you plan

1. **Failed requests and empty results are never charged.** Just call it.
2. **Cache hits cost 0 credits.** Pass `--cache-max-age 7d` (or `cache_max_age=7d`)
   whenever real-time data is not required.
3. **Many targets means one batch, not a loop.** Up to 500 targets per job.

## CLI

```bash
npm install -g truescrape          # or: npx truescrape <command>
truescrape auth login              # stores your key (0600) after checking it
truescrape list                    # platforms
truescrape list youtube            # endpoints for one platform
truescrape youtube channel --handle @mkbhd
truescrape youtube channel-videos --handle @mkbhd --all | jq '.items[].viewCount'
truescrape youtube channel --handle @mkbhd --cache-max-age 24h --format table
truescrape batch youtube transcript --targets ids.json --wait
truescrape balance
```

Every endpoint is `truescrape <platform> <action> --param value`. Run any
command with `--help` for its parameters, cost and any cross-field rule.

**Authentication**, in order of precedence: `--api-key` for one request
(visible in shell history; avoid for anything persistent), the
`TRUESCRAPE_API_KEY` environment variable (use this in CI and for agents),
then the key stored by `truescrape auth login`.

**Output.** Data goes to stdout as compact JSON; the billing line
(`1 credit · live fetch · 412 ms · req_…`) goes to stderr, so pipes stay clean.

| Flag | Effect |
|---|---|
| `--format json\|table\|csv\|markdown` | Output format (default `json`) |
| `--pretty` | Indented JSON |
| `--envelope` | Print `{ data, meta, pagination }` instead of `data` |
| `--output <path>` | Write to a file and print only its path |
| `--all`, `--max-pages <n>` | Follow the cursor and merge pages (default cap 10) |
| `--quiet` | No billing line |
| `--verbose` | Request URL, status and timing on stderr |
| `--base-url <url>` | Another API origin (also `TRUESCRAPE_BASE_URL`) |

Exit codes: `0` success · `1` the API returned an error · `2` usage or
configuration error · `3` the API could not be reached. When stderr is not a
terminal, errors are one JSON line in the API's own shape, with the request id
from the response header beside it:
`{"success":false,"error":{"code":"invalid_api_key","message":"…"},"requestId":"req_…"}`.
A 401 is always a key problem and a 402 always a balance problem; the CLI
never conflates them.

## MCP server

The API serves a remote MCP server at `https://api.truescrape.com/mcp`. Every
endpoint is a tool; every call goes through the same billing rules as HTTP.

```bash
# Claude Code
claude mcp add --transport http truescrape https://api.truescrape.com/mcp \
  --header "x-api-key: YOUR_KEY" --scope user

# Or let the CLI write the config for you
truescrape agent add claude-code
truescrape agent add cursor            # ~/.cursor/mcp.json (--project for .cursor/mcp.json)
truescrape agent add vscode            # .vscode/mcp.json
truescrape agent add claude-desktop    # claude_desktop_config.json, via the stdio bridge below
```

Cursor and VS Code, by hand:

```json
{ "mcpServers": { "truescrape": { "url": "https://api.truescrape.com/mcp", "headers": { "x-api-key": "YOUR_KEY" } } } }
```

```json
{ "servers": { "truescrape": { "type": "http", "url": "https://api.truescrape.com/mcp", "headers": { "x-api-key": "YOUR_KEY" } } } }
```

Clients that can only launch a local process get the same server through the
bridge, which forwards stdio to the remote endpoint with your stored key:

```json
{ "mcpServers": { "truescrape": { "command": "npx", "args": ["-y", "truescrape", "mcp"], "env": { "TRUESCRAPE_API_KEY": "YOUR_KEY" } } } }
```

The server advertises its URL, transport and auth header at
`https://api.truescrape.com/.well-known/mcp`; `agent add` reads that rather
than assuming.

## Agent skill

The skill teaches an agent endpoint selection, the cost model, batching,
subscriptions and the platform quirks worth knowing, with the full endpoint
table generated from the live API.

```bash
npx skills add TrueScrape/truescrape                 # Claude Code, Cursor, Codex, Copilot, Gemini CLI, Windsurf
```

As a Claude Code plugin, which installs the skill and the MCP server together
(the server reads `TRUESCRAPE_API_KEY`):

```bash
claude plugin marketplace add TrueScrape/truescrape
claude plugin install truescrape@truescrape
```

The skill lives at [`skills/truescrape/SKILL.md`](skills/truescrape/SKILL.md).
[`AGENTS.md`](AGENTS.md) is the short version for agents that already have the CLI.

## Development

```bash
pnpm install
pnpm test           # vitest
pnpm typecheck
pnpm catalogue      # regenerate src/catalogue.json and the generated blocks from the live API
pnpm build          # dist/index.js
```

The endpoint catalogue is generated, never edited: CI fails when the committed
snapshot differs from the live API, and a daily job opens a pull request when
the API gains an endpoint. Running a command the bundled catalogue does not
know triggers one live refresh before the CLI gives up.

## License

MIT.
