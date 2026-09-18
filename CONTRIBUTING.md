# Contributing to vsdiff

Start with a small, reproducible change. If you are changing a review workflow,
show the trigger, the current behavior, and the result you want. Use an issue for
feature discussion and the private reporting path in [SECURITY.md](SECURITY.md)
for vulnerabilities.

## Work locally

Use Node.js 22+ and pnpm 9.15.9.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm check
pnpm audit
```

`pnpm build` produces `dist/vsdiff.vsix` and the CLI under `packages/cli/dist/`.
The lockfile pins the build and packaging tools. Nothing is published by building.

## Check the actual editor

Install VS Code and make `code` available on PATH. The dev harness downloads its browser server on first launch through `code serve-web`.
The download requires internet access and accepts Microsoft's server license terms.

```bash
pnpm fixture
pnpm web start
pnpm e2e
```

The harness uses a separate local server on port 3111. Screenshots and test
workspaces stay under ignored `.dev/` paths. Its control bridge requires a
per-process token stored in `.dev/bridge.json`; the helper reads it automatically.
Do not publish bridge files, server tokens, or authenticated browser URLs.

After changing the extension, use `pnpm build && pnpm web restart`. A test against
an old extension host does not verify the new source. Shut down with `pnpm web stop`.

The security tests exercise real HTTP requests, Git processes, filesystem
symlinks, and a hostile guide in the browser. Keep the negative cases when changing
those boundaries. Tests do not replace a security review of a new entry point.

## Record the demo

```bash
pnpm build
pnpm web restart
pnpm media
node scripts/render-demo.mjs
```

This captures a fresh, isolated payment-retry review through the real editor.
Rendering needs FFmpeg. The final MP4, GIF, screenshots, and captions describe the
recorded workflow; do not substitute a mockup for the working product.

## Keep changes reviewable

- Preserve unrelated working-tree changes.
- Keep security validation at the point where a file is read or an action runs.
- Test behavior that can fail, including failure paths. Avoid tests that only
  repeat implementation details.
- Match claims to evidence: a build, a unit test, a browser action, and a live
  GitHub write prove different things.
- Public documentation must not contain private review contents, machine paths,
  credentials, or claims based on an old development run.

The project uses the MIT license. Contributions are accepted under that license.
