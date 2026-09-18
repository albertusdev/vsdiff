# How vsdiff fits together

The agent authors a review; the human owns the decision. Files in the repository
are the shared contract, so the editor and agent do not need to share a process.

| Package | Responsibility |
| --- | --- |
| `schema` | Session types, JSON Schema, validation, and the authoring guide. |
| `core` | Git diffs, hunk resolution, configuration, and feedback files. No editor API. |
| `extension` | Native diff navigation, guide and feedback threads, outline, and Overview. |
| `cli` | Session creation, validation, editor launch, waiting, feedback commands, and MCP. |
| `github` | PR metadata, comment mapping, and explicit publication through `gh`. |
| `e2e` | Real VS Code browser tests and reproducible media capture. |

A session lives at `.vsdiff/sessions/<name>/session.json`. The editor recomputes
its Git diff and resolves each `path:h<n>` reference. Changed or stale references
are surfaced to the reviewer. Feedback appends to `feedback.jsonl`; finishing
writes `result.json`, which releases a waiting `vsdiff open --await`.

The Overview is a webview owned by vsdiff. Its content is escaped, and its message
handler accepts a fixed set of review actions. Inline prose and conversations use
VS Code's native comment API. Agent-authored HTML guides are a separate surface
with Workspace Trust, a content security policy, a session-directory resource
boundary, and limited navigation messages.

The optional browser target launches Microsoft's `code serve-web` on loopback.
A file readable only by the current user holds its connection token. The CLI
passes an authenticated launch URL to the browser. There is no vsdiff-hosted
backend or model integration.

The dev bridge is a separate, opt-in testing interface. It is disabled unless the
test environment explicitly enables it. It accepts bearer-authenticated requests
from local tools and rejects browser origins. It is not the production agent
transport: the CLI and MCP use the session and feedback files.

See [SECURITY.md](../SECURITY.md) for limits and the reporting process.
