# vsdiff — conventions for agents working in this repo

Read `CONTRIBUTING.md`, `docs/architecture.md`, and `SECURITY.md` before changing the project. Use `vsdiff guide` for the current session format.

## Hard rules

- **core/extension split**: everything testable without an editor lives in `packages/core` or `packages/schema` (no `vscode` imports there, ever). `packages/extension` is a thin UI layer over core.
- **Headless parity (R18)**: every UI action gets a command ID reachable via the dev bridge. If it can only be exercised by clicking, it doesn't merge.
- **Evidence over assertion**: a change is done when the harness proves it — vitest for core, Playwright + bridge asserts + screenshots (`.dev/shots/`) for UI. Say what you ran and what it showed.
- **No new runtime dependencies without tech-lead approval.** Dev-tooling is pinned via the pnpm catalog in `pnpm-workspace.yaml`.
- **GitHub side effects** (push, PR comments, `gh api` writes) always prompt — never work around a permission ask.

## Build & loop

```bash
pnpm install --frozen-lockfile
pnpm build          # per-package tsdown/tsc + vsix
pnpm test           # vitest via vite-plus
pnpm web restart    # reinstall the built vsix into serve-web on :3111
pnpm e2e            # Playwright smoke → .dev/shots/*.png + bridge asserts
```

The dev bridge (`VSDIFF_DEV_BRIDGE=1`, wired automatically by `scripts/web.mjs`) exposes `GET /state` and `POST /exec {command, args}` on loopback; its port and bearer token are written to `.dev/bridge.json` with mode 0600. Requests require that token, and browser origins are rejected. The bridge is test-only; production CLI feedback uses files.

## Style

- TypeScript strict; ESM everywhere except the extension entry (CJS bundle, `vscode` externalized).
- Small files, named exports, no default exports. Match surrounding code; comments only for non-obvious constraints.
- Commit messages: imperative, scoped prefix (`extension:`, `core:`, `harness:`, `docs:`), body only when the why isn't obvious.
