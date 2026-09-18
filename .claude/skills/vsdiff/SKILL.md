---
name: vsdiff
description: Author a guided code review session and hand it to the human in VS Code via vsdiff. Use when the user writes "$vsdiff" or "/vsdiff", asks to "open vsdiff", wants a guided/narrative review of changes, or when you finish a substantial change and the user should review it before you continue. Also use to service review feedback ("check vsdiff feedback", "address the review comments").
metadata:
  short-description: Guided review handoff in VS Code
---

# vsdiff — guided review handoff

You author a **Review Session** (one JSON file) because you already hold the context that produced the change. vsdiff owns the format and its authoring guide — this skill only carries the workflow. The human reviews natively in VS Code (or Cursor/Windsurf); their comments and verdicts come back to you as data.

## Authoring workflow

1. **Get the current format truth from the tool** (never from memory — it's versioned with the binary):

   ```bash
   vsdiff guide            # authoring guide: shape, hunk ids, length budgets
   vsdiff guide --schema   # the JSON Schema, if you want it
   ```

2. **Pick the diff.** Default to what you just changed: `--working-tree` for uncommitted work, `--base <ref>` for a committed branch (three-dot merge-base semantics, like a PR). Then scaffold and read the hunk inventory:

   ```bash
   vsdiff new --base main --head HEAD --title "Auth flow refactor" --json
   ```

   The output lists every changed file with its hunk ids (`path:h<n>`) — anchor stops against exactly these. Untracked files do not appear in working-tree diffs; commit or stage them first if they matter.

3. **Author the session** into the scaffolded `session.json`: chapters ordered by review leverage, one review idea per stop, findings/questions marked with `kind` (+ `severity` for findings), mechanical changes into `support`. Respect the length budgets — the validator enforces them.

4. **Validate strictly and fix every issue** (the errors are written for you, with hints):

   ```bash
   vsdiff validate .vsdiff/sessions/<dir>/session.json
   ```

5. **Hand off.** Blocking is the default for review requests; give it a timeout when running unattended:

   ```bash
   vsdiff open --await --timeout 600   # parks until the human finishes; JSON result on stdout
   ```

   stdout is pure JSON (progress goes to stderr) — never pipe `2>&1` into a JSON parser.

## Reading the result

- `"status": "approved"` — proceed; open threads in `openThreads` are advisory notes, read them.
- `"status": "changes-requested"` — do NOT proceed. Service the feedback (below), fix the code, then hand off again.
- `"status": "canceled"` (exit 2, includes timeout) — **never treat as approval**. Tell the user and ask how to proceed.

## Servicing feedback

```bash
vsdiff feedback --json               # comments/verdicts so far; pass its `nextLine` back as --after <n> to resume
vsdiff feedback --wait --timeout 600 # block until something new (exit 3 on timeout)
vsdiff reply --thread <id> --body "Fixed in <commit> — <one line how>"
vsdiff resolve --thread <id>         # only after you actually addressed it
```

Reply before you resolve, so the human sees what happened. Never resolve a thread you didn't act on. After you commit fixes, the editor re-resolves the session against the new diff automatically; update stops whose hunks moved if you touch the session again.

## Proposal mode — first-pass review of a colleague's PR

When the user delegates reviewing SOMEONE ELSE'S PR ("review PR #N for me", "draft a review of X's change"):

1. `vsdiff pr <number>` — checks out the PR and scaffolds a session pinned to its head SHA.
2. Author the session with `"intent": "proposal"`. Your `finding`/`question` stops ARE the draft
   review comments (title + prose = what would post, verbatim — write them as you'd write to the
   PR author, not to the reviewer). `walkthrough`/`verify` stops remain private guidance for the
   human triager and never post.
3. Write the draft review BODY to `<session dir>/review.md` — the human edits that file directly;
   whatever it contains at post time is what posts.
4. Validate, then hand off with `vsdiff open --await --timeout 600`. The human triages each draft
   in the editor (accept / edit / drop) and may post from there, or approve the handoff and ask
   you to run `vsdiff pr publish --event <comment|approve|request-changes>` — which posts ONLY
   accepted and edited drafts plus the current review.md, one atomic pending review. Dropped
   drafts never leave the machine.
5. Their triage decisions land in the feedback log as `triage` events — read them (`vsdiff
feedback --json`) and learn: what they drop or reword is calibration for your next first pass.

GitHub rule: APPROVE and REQUEST_CHANGES are forbidden on your OWN PRs (422) — proposal mode
targets colleagues' PRs, where all three events work.

## MCP alternative

The same verbs exist as MCP tools via `vsdiff mcp` (`vsdiff_new`, `vsdiff_validate`, `vsdiff_feedback`, `vsdiff_reply`, `vsdiff_await`, …) for tool-preferring harnesses. Files remain the source of truth either way.
