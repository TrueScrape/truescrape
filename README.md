<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://truescrape.com/brand/truescrape-logo-transparent-for-dark-bg.png">
  <img alt="TrueScrape" src="https://truescrape.com/brand/truescrape-logo-transparent-for-light-bg.png" width="280">
</picture>

# TrueScrape

[![npm](https://img.shields.io/npm/v/truescrape)](https://www.npmjs.com/package/truescrape)
[![downloads](https://img.shields.io/npm/dm/truescrape)](https://www.npmjs.com/package/truescrape)
[![MCP](https://img.shields.io/badge/MCP-remote%20server-blue)](#mcp-server)
[![license](https://img.shields.io/npm/l/truescrape)](LICENSE)

Public social media data from one API: Instagram, TikTok, YouTube, X,
Facebook, LinkedIn, Reddit, Threads and more. Profiles, posts, videos,
comments, transcripts, ad libraries and metrics, all in one schema. Use it
from the terminal, from scripts, or as an MCP server for Claude, Cursor and
VS Code.

- **1,000 free credits on signup**, no card. Most requests cost 1 credit.
- **Failed and empty requests are never charged**, and cache hits cost 0.
- **Credits never expire.** No subscription; packs from $25 for 20,000 credits.

```console
$ truescrape instagram profile --handle natgeo --pretty
{
  "platform": "instagram",
  "id": "787132",
  "handle": "natgeo",
  "displayName": "National Geographic",
  …
  "verified": true,
  "followerCount": 268245801,
  "followingCount": 195,
  "postCount": 32000,
  …
}
1 credit · live fetch · 1204 ms · req_…
```

This repository holds the three ways to plug it into your tools and your
agents.

| | Install | Best for |
|---|---|---|
| **CLI** | `npm install -g truescrape` or `npx truescrape …` | Scripts, cron, CI, one-off pulls, piping into `jq` |
| **MCP server** | `claude mcp add --transport http truescrape https://api.truescrape.com/mcp --header "x-api-key: YOUR_KEY"` | Claude, Cursor, VS Code and any MCP client calling endpoints as tools |
| **Agent skill** | `npx skills add TrueScrape/truescrape` | Teaching Claude Code, Cursor, Codex, Copilot, Gemini CLI or Windsurf how to use the API well |

<!-- catalogue:start -->
**251 endpoints across 45 platforms**, generated from the live API on 2026-10-30.

tiktok (28) · facebook (22) · instagram (19) · youtube (17) · deezer (11) · github (10) · reddit (9) · google (8) · linkedin (8) · mixcloud (8) · peertube (7) · spotify (7) · twitter (6) · dailymotion (5) · odysee (5) · rumble (5) · substack (5) · threads (5) · amazon (4) · apple-music (4) · bitchute (4) · mastodon (4) · pinterest (4) · redfin (4) · twitch (4) · walmart (4) · bluesky (3) · kwai (3) · snapchat (3) · soundcloud (3) · telegram (3) · truthsocial (3) · zillow (3) · ebay (2) · identity (1) · inference (1) · kick (1) · komi (1) · linkbio (1) · linkme (1) · linktree (1) · milkshake (1) · pillar (1) · solo (1) · taplink (1)
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
truescrape download https://x.com/<handle>/status/<id> --out ./videos
truescrape balance
```

`truescrape download <post-url> [--out <dir>] [--force] [--json]` saves the
video from a public Instagram, Facebook or X post. The lookup costs 1 credit
and nothing if it fails; the file comes straight from the platform's own video
servers, checked to be https, unredirected, a video, and under 150 MB. YouTube
links are refused. Only download videos you made or have permission to use.

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
