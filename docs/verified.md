# Verified with real clients

Each release is driven once from each client below before it is published.
Entries are prose only: the client, its version, the date, whether the tool
count matched what the API advertises at `/.well-known/mcp`, and whether one
call completed. No logs, no paths, no numbers pasted from a session.

## 0.1.0 (pre-release, 2026-09-03)

**Skill install.** `npx skills add TrueScrape/truescrape --list` against the
GitHub repository found exactly one skill, `truescrape`, with the expected
description. Installer version: the current `skills` package on npm that day.

**Plugin install.** `claude plugin marketplace add TrueScrape/truescrape` then
`claude plugin install truescrape@truescrape` on Claude Code 2.1.258 (Windows)
installed the plugin at user scope, enabled, version 0.1.0.
`claude plugin validate .` passes, with and without `--strict`.

**Cursor.** `truescrape agent add cursor --dry-run` read discovery from the
live API and produced a config that kept the three unrelated servers already
present in the local Cursor file untouched. Nothing was written. A live Cursor
session has not yet been driven: no API key was available on the machine.

**Claude Desktop.** `truescrape agent add claude-desktop --dry-run` on Windows
produced the launcher entry with the platform-appropriate command and kept
every existing preference in the file. Nothing was written. A live session
has not yet been driven for the same reason.

**Claude Code, remote MCP.** `truescrape agent add claude-code --dry-run`
prints the `claude mcp add` line with the endpoint and header name read from
discovery. Not yet run with a real key.

**Stdio bridge.** With a deliberately invalid key, the bridge turned the API's
real 401 into a JSON-RPC error whose `data.code` is `invalid_api_key`, which
is what an MCP client shows instead of "failed to connect". The
`initialize` and `tools/list` round trip with a valid key, and the tool-count
comparison against discovery, are in the opt-in live test and wait for a key.

**VS Code.** Not installed on the verification machine; the file and entry
shape are covered by unit tests against the documented format.
