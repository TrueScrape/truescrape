# Verified with real clients

Each release is driven once from each client below before it is published.
Entries are prose only: the client, its version, the date, whether the tool
count matched what the API advertises at `/.well-known/mcp`, and whether one
call completed. No logs, no paths, no numbers pasted from a session.

| Client | Path used | Version | Date | Tool count matched discovery | One call completed |
|---|---|---|---|---|---|
| Claude Code | `claude mcp add --transport http` | | | | |
| Claude Desktop | `truescrape agent add claude-desktop` (stdio bridge) | | | | |
| Cursor | `truescrape agent add cursor` | | | | |
| VS Code | `truescrape agent add vscode` | | | | |
| Skill install | `npx skills add TrueScrape/truescrape` | | | | |
| Plugin install | `claude plugin install truescrape@truescrape` | | | | |
