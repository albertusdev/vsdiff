# Agents: reviewing changes with vsdiff

This repo (and any repo with vsdiff installed) supports guided review handoffs. If a human asks you for a review in vsdiff, or you want a human to review your change before continuing:

1. `vsdiff guide` — the session format, from the tool itself (versioned, never stale).
2. `vsdiff new --base <ref> --head HEAD --title "…" --json` — scaffold + the hunk inventory to anchor against (`path:h<n>`).
3. Author chapters/stops into the scaffolded `session.json`; `vsdiff validate <file>` until clean.
4. `vsdiff open --await` — blocks until the human finishes; structured result on stdout. `canceled` is never approval.
5. Service feedback: `vsdiff feedback --json` / `--wait`, `vsdiff reply --thread <id> --body …`, `vsdiff resolve --thread <id>` (reply first, resolve only what you addressed).

MCP: `vsdiff mcp` (stdio) exposes the same verbs as tools. Claude Code users: the packaged skill lives at `skills/claude/vsdiff/`.
