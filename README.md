<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://truescrape.com/brand/truescrape-logo-transparent-for-dark-bg.png">
  <img alt="TrueScrape" src="https://truescrape.com/brand/truescrape-logo-transparent-for-light-bg.png" width="280">
</picture>

# TrueScrape

[![npm](https://img.shields.io/npm/v/truescrape)](https://www.npmjs.com/package/truescrape)
[![downloads](https://img.shields.io/npm/dm/truescrape)](https://www.npmjs.com/package/truescrape)
[![MCP](https://img.shields.io/badge/MCP-remote%20server-blue)](#mcp-server)
[![license](https://img.shields.io/npm/l/truescrape)](LICENSE)

**Live context for your agent: competitors, mentions and markets.** An agent can
read your code and files. It cannot see your competitors, your market, or what
people say about you. Connect it in one line:

```bash
npx truescrape auth login                # once: stores your key from truescrape.com/dashboard
npx truescrape agent add claude-code     # or: claude-desktop, cursor, vscode
```

Then ask it for one of three jobs:

| Job | Ask your agent | What it uses |
|---|---|---|
| **Research on demand** | "What are people saying about standing desks, and what do they cost on Amazon and Walmart?" | Search and profile tools across social platforms, plus Amazon and Walmart search |
| **Watch competitors and accounts** | "Watch Acme's YouTube channel and tell me what's new" | A monitor on their accounts. No webhook needed, and it checks when your agent asks |
| **Find mentions** | "Who is mentioning Acme, and what needs a reply?" | One search across public sources, each reporting what it found or that it could not be checked |

Public, logged-out data only. Monitors check on request, or on a schedule of an
hour or longer.

- **1,000 free credits on signup**, no card. Most requests cost 1 credit.
- **Failed and empty requests are never charged**, and cache hits cost 0.
- **Credits never expire.** No subscription; packs from $25 for 20,000 credits.

It all works without an agent too, from the terminal or your own scripts:

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
**253 endpoints across 46 platforms**, generated from the live API on 2026-11-01.

tiktok (28) · facebook (22) · instagram (19) · youtube (17) · deezer (11) · github (10) · reddit (9) · google (8) · linkedin (8) · mixcloud (8) · peertube (7) · spotify (7) · twitter (6) · dailymotion (5) · odysee (5) · rumble (5) · substack (5) · threads (5) · amazon (4) · apple-music (4) · bitchute (4) · bluesky (4) · mastodon (4) · pinterest (4) · redfin (4) · twitch (4) · walmart (4) · kwai (3) · snapchat (3) · soundcloud (3) · telegram (3) · truthsocial (3) · zillow (3) · ebay (2) · hackernews (1) · identity (1) · inference (1) · kick (1) · komi (1) · linkbio (1) · linkme (1) · linktree (1) · milkshake (1) · pillar (1) · solo (1) · taplink (1)
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

### Mentions and monitors

```bash
truescrape mentions find "Acme"                 # one search, nothing stored
truescrape monitors create "Acme" --manual      # keep watching; checks only when you say
truescrape monitors create "Acme" --no-search --accounts youtube:@acme,bluesky:acme.com --manual
truescrape monitors create "Acme" --interval 21600 --stop-at <ISO time> --max-credits <n>
truescrape monitors check <id>                  # check each source now, report what is new
truescrape monitors updates --unread            # read what this key has not read
truescrape monitors updates --platform reddit --source mention --since 7d
truescrape monitors list
truescrape monitors delete <id>
```

Each takes `--json`, and exits `1` on an API error. Creating and reading are free.
`mentions find` costs 1 credit per source that answers. A check charges each source
that answers at its endpoint's own price; `creditsPerCheck` in the create response
is the most one check can charge, and the first check is a baseline that reports
nothing as new. Failed, empty and cached answers are free, and the output names
each source that could not be checked, so a failure never reads as "no mentions".

**Mention sources:** Reddit, Hacker News, Bluesky, YouTube, Threads, Instagram tags,
TikTok tags, Dailymotion, PeerTube and Odysee. PeerTube and Odysee have no date order
and may rarely surface new videos. X, LinkedIn search and Instagram captions are not
covered.

**Accounts** can be followed on YouTube, TikTok, Instagram, Threads, Bluesky, Reddit,
Mastodon (the handle includes the server), Telegram, Substack and LinkedIn. X and
Facebook accounts are not available.

An agent creating a monitor passes `--agent <name>`, so you can see what it left
running. A scheduled monitor runs until deleted unless you set `--stop-at` or
`--max-credits`.

`truescrape download <post-url> [--out <dir>] [--force] [--json]` saves the
video from a public Instagram, Facebook, X, Streamable, Mashable, Flickr or
Bilibili post. The lookup costs 1 credit and nothing if it fails; the file comes
straight from the platform's own video servers, checked to be https,
unredirected, a video, and under 150 MB. YouTube, Vimeo and OK.ru links are
refused: they offer no plain file a CLI can fetch. Only download videos you made
or have permission to use.

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

**`agent add` installs a default toolset, not every tool,** which leaves the agent
room to work: `youtube`, `tiktok`, `instagram`, `reddit`, `threads`, `bluesky`,
`hackernews`, `amazon` and `walmart`. From the agent, `explore_tools` finds any other
tool and `call_tool` runs it. Change the set by adding the client again; a config you
already have stays as it is until you do:

```bash
truescrape agent add cursor --platforms youtube,instagram    # only these
truescrape agent add cursor --all                            # every tool
```

A URL you write by hand loads every tool unless you add `?platforms=`:

```bash
claude mcp add --transport http truescrape "https://api.truescrape.com/mcp?platforms=youtube,instagram" \
  --header "x-api-key: YOUR_KEY" --scope user
```

Tools can be listed without a key, so you can inspect them before signing up;
calling one needs the key.

The server advertises its URL, transport and auth header at
`https://api.truescrape.com/.well-known/mcp`; `agent add` reads that rather
than assuming.

## Agent skills

`truescrape` teaches an agent endpoint selection, the cost model, batching,
mentions, monitors, subscriptions and the platform quirks worth knowing, with the
full endpoint table generated from the live API. Workflow skills build on it:

| Skill | What it does |
|---|---|
| [`competitor-watch`](skills/competitor-watch/SKILL.md) | Follows a competitor's accounts and reports what changed since last time |
| [`mention-digest`](skills/mention-digest/SKILL.md) | Public mentions grouped by source, each with its link, flagging what needs a reply |
| [`market-scan`](skills/market-scan/SKILL.md) | A question about a category, across social posts and Amazon and Walmart search |
| [`video-to-content-brief`](skills/video-to-content-brief/SKILL.md) | Turns a sample of YouTube videos into a source-linked brief: themes, hooks and new angles |
| [`competitor-content-audit`](skills/competitor-content-audit/SKILL.md) | Compares the same recent sample of uploads across 2 to 5 YouTube channels |

Each states its cost and that its sample is a sample, and keeps a link to the
source beside every claim.

```bash
npx skills add TrueScrape/truescrape                 # pick from the list; Claude Code, Cursor, Codex, Copilot, Gemini CLI, Windsurf
npx skills add TrueScrape/truescrape --skill video-to-content-brief
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
