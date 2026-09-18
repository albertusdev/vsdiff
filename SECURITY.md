# Security

vsdiff is a local CLI and editor extension. It does not provide a hosted service
or call an AI model. The optional browser mode runs Microsoft's VS Code server
on your machine.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/albertusdev/vsdiff/security/advisories/new).
Include the affected version, a minimal reproduction, and the impact you can
show. Do not post credentials, private code, or an exploit against someone else's
machine in a public issue. Only the latest release receives security fixes.

## What is protected

- Git references and paths are passed as arguments, never shell strings. Diff
  reads disable external diff, text-conversion, and filesystem-monitor programs.
- Repository config cannot supply a custom executable or redirect browser server
  storage. Those settings belong in the user's own config.
- Session prose is untrusted Markdown or escaped text. Agent-authored HTML guides
  require Workspace Trust and receive a policy before any agent markup. Network
  fetches and form submissions are blocked. Guide file reads and file-navigation
  messages reject traversal, absolute paths, and symlink escapes.
- Browser servers bind to `127.0.0.1` and require a random connection token. The
  token file is readable only by the current user. A server with missing or
  mismatched authentication is not silently reused.
- The dev control bridge is disabled by default. When explicitly enabled for
  tests, it requires a per-process bearer token, rejects browser origins and
  unexpected Host headers, requires JSON, and limits request bodies.
- GitHub writes use the locally authenticated `gh` CLI. They are explicit actions;
  merely reading a local review does not post comments to GitHub.

## Limits

This is not a sandbox for hostile projects or agents. An agent with permission to
run commands already has the permissions of its host account. VS Code, installed
extensions, Git, `gh`, and their own settings remain part of the trusted system.
A process running as your user can read your token and files. Loopback binding and
connection tokens do not protect against that process or against an administrator.

Keep authenticated browser URLs and `.dev/bridge.json` private. Do not expose the
local server through a public proxy or port forward. This release does not provide
a supported multi-user server mode. Use the desktop editor on a shared host when
you cannot keep the browser credentials private.

HTML guide scripts can control their own webview and request the documented
navigation actions after trust is granted. They should still be reviewed before
trusting a repository. Workspace Trust is not a claim that arbitrary HTML is safe.

`feedback.jsonl`, `result.json`, and session files may contain private code or
review comments. Keep `.vsdiff/` out of version control unless you deliberately
intend to share those files. The `.gitignore` entry created by `vsdiff init` helps;
it does not remove files already committed.

## Release checks

The launch checks include a reachable-history secret scan, dependency audit,
real Git hook probes, HTTP authorization and malformed-request tests, symlink and
traversal tests, and a hostile HTML guide in the actual browser workbench. The
[release verification notes](docs/release-verification.md) record the scope and
results. These checks are maintainer testing, not an independent penetration-test
certification or a guarantee that no vulnerabilities remain.
