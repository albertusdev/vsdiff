# Changelog

## 0.2.0 — First open-source release

vsdiff turns an agent's explanation into a guided review in VS Code or a local
browser. This release includes the source, CLI, and a manually installed VSIX.

### Review together

- Chapters and stops connect the explanation to real diff hunks. The outline also
  shows changed files the guide does not cover.
- Overview opens as a normal tab, with an option to pin it beside the code.
  Focus Review makes room in narrow browser panes. Pinning opens a review diff
  even when VS Code has restored a Welcome or untitled tab.
- Inline guide replies, line comments, and drafts stay with the review as the
  layout changes. Long guide text can be expanded in place.
- The CLI and MCP expose session creation, validation, waiting, feedback, replies,
  and explicit GitHub review publication.
- Staged reviews show the index. Commit and branch reviews show the selected Git
  snapshots; branch reviews use the merge base, even when the checkout differs.

### Safer local boundaries

- Browser mode requires a private connection token and rejects reuse of an
  unprotected server. Installing vsdiff preserves other extensions.
- The opt-in test bridge requires authentication and rejects browser origins.
- Diff reads disable text-conversion, external-diff, and filesystem-monitor
  programs. Repository config cannot choose a custom executable or browser
  storage directory.
- HTML guides require Workspace Trust. Their content policy applies before
  source markup; file navigation rejects traversal and symlink escapes.
- Updated build dependencies resolve the advisories found during launch review.

### Getting started

The README includes source installation, a runnable payment-retry demo, a recorded
walkthrough, and the agent feedback loop. Contributor and architecture notes
explain how to work on the project. The repository and VSIX include the MIT license.

See [release verification](docs/release-verification.md) for tested boundaries and
known limits. There is no Marketplace, OpenVSX, or npm publication in this release.
