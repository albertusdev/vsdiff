# Release verification: 0.2.0

This is a maintainer assessment of the first open-source release, performed on
2026-09-18 on Linux. It combines code review, adversarial probes, regression tests,
and the installed extension in Microsoft's VS Code browser workbench. It is not
an independent penetration test or a guarantee that the software has no defects.

The local build used Node.js 22.22.2 and pnpm 9.15.9. Browser checks used VS Code
server 1.135.0. A clean source export passed frozen installation, build, typecheck,
lint, unit tests, dependency audit, and the demo command. Its extension JavaScript
bundle matched the working checkout byte for byte.

The release's source archive identifies the exact commit in `BUILD-INFO.txt`.
`SHA256SUMS` covers the attached source, VSIX, demo, captions, and these notes.
The public repository starts from the reviewed launch snapshot; private design
notes and earlier development history are not part of that snapshot.

## Findings fixed before release

| Boundary | Reproduction and result |
| --- | --- |
| Dev bridge | A cross-origin `text/plain` POST could invoke editor commands when the optional bridge was enabled. It now requires a random bearer token, rejects Origin and unexpected Host headers, requires JSON, and limits bodies. Real HTTP tests cover unauthorized requests and valid local control. |
| Git reads | Harmless marker scripts demonstrated that textconv and fsmonitor could execute during a diff read. Both are disabled. Real Git regression tests verify the diff still loads without creating the marker. |
| Repository config | Repo config could select an executable or redirect browser storage. Those settings are now accepted only from user config. Regression tests preserve normal repository review preferences. |
| HTML guides | Source markup could precede the injected content policy, and advisory validation did not prevent escaped paths. The policy now precedes source markup, and paths are checked at use, including realpath containment. A browser test runs a hostile guide before and after trust, observes a blocked fetch and zero collector requests, and rejects traversal and symlink escapes. |
| Browser server | Anonymous local access was enabled in the earlier build. The launcher now creates a private token file, requires authentication, and refuses to reuse an unprotected or different server. An isolated real server returned 403 to anonymous and wrong-token requests, and 302 to the authenticated launch. |
| Extension install | Browser updates no longer delete unrelated extensions. A sentinel extension survived a real VSIX installation. |
| Review contents | Historical and staged diff editors could prefer checkout files. They now use the selected Git snapshots or index; the range base matches Git's merge base. A browser regression uses different base-branch, index, and checkout contents to detect mix-ups. |
| Overview pinning | A restored Welcome or untitled tab could leave the pinned map without a review diff. Pinning now checks for a real diff. The browser regression deliberately opens an extra utility tab and exercises pinning, drafts, and refresh. |
| Dependencies | The initial audit found two moderate advisories in the Vitest toolchain. Updating the pinned build tools removed those findings. The final dependency audit reports no known vulnerabilities. |

## Reproduce the checks

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm check
pnpm test
pnpm audit --audit-level=moderate
pnpm fixture
pnpm web start
pnpm e2e
```

Secret scanning uses Gitleaks 8.30.1 against the launch tree, reachable `main`
history, and extracted release contents. Findings must be reviewed, not merely
hidden with an allowlist. The release excludes `.dev/`, local tokens, private
review sessions, dependency directories, and local editor permission settings.

The demo is recorded from the real editor. It shows opening the review map,
following a stop, expanding the guide, submitting an inline reply, pinning and
unpinning Overview, inspecting the test, and requesting changes. It demonstrates
that path only; it does not prove all editor workflows or platforms.

## Limits and follow-up

- Linux is the exercised platform. macOS install scripts and VS Code forks have
  not been verified for this release. Native Windows installation is unsupported.
- Browser tests use a real local VS Code workbench with Playwright. They do not
  prove physical keyboard input or every embedding application's focus behavior.
- The existing-server installation path was tested. A completely fresh machine's
  first Microsoft server download was not exercised.
- GitHub PR payloads and triage have regression coverage. The release audit did
  not post a live review to another repository.
- Coverage and automatic checkmarks estimate what was displayed. They do not
  prove that a person read or understood a change.
- Loopback authentication does not protect against processes running as the same
  user. HTML guides are executable content after trust. See [SECURITY.md](../SECURITY.md).
- Dependency and secret scanners detect known patterns and advisories. A clean
  result does not prove the absence of credentials or undiscovered vulnerabilities.
