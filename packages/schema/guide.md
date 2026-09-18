# Review Session — authoring guide

This is vsdiff's guidance for authoring a **Review Session**: one JSON file that turns your
understanding of a change into a guided review inside VS Code. Chapters and stops carry your
prose; hunk ids and line anchors point at real code. The diff itself is never embedded — vsdiff
recomputes it from the repository on every load and renders the live version, so a session stays
useful after you push a fix.

A review is more than a walkthrough. You are not only narrating what changed: you can flag
findings with a severity, ask the author a question, and ask the reviewer to verify something.
The reviewer answers in the editor and their comments and verdicts come back to you.

Write the session to `.vsdiff/sessions/<slug>/session.json` in the repository under review.

## Pick the diff first

Everything in the file is anchored against one diff, named by `source`. Choose it before you
write anything else, and read that exact diff:

| `source`                                              | the diff it means                              |
| ----------------------------------------------------- | ---------------------------------------------- |
| `{ "type": "working-tree" }`                          | `git diff HEAD` — staged and unstaged          |
| `{ "type": "staged" }`                                | `git diff --staged`                            |
| `{ "type": "commit", "head": "<sha>" }`               | `git diff <sha>^ <sha>`                        |
| `{ "type": "range", "base": "main", "head": "HEAD" }` | `git diff main...HEAD` — merge-base, like a PR |

Unless the user named a target, use `staged` when the change is staged and `working-tree`
otherwise. Say which one you chose in `focus` when it isn't obvious.

## Hunk ids

A hunk id is `<path>:h<n>`:

- `<path>` is the file's repo-relative path on the **new** side (the old path for deletions,
  the new path for renames).
- `<n>` is the 1-based position of the hunk in that file's patch — the first `@@ … @@` block is
  `h1`, the second `h2`, and so on. Ordinals restart at 1 for every file.

Count them off **plain `git diff` output** with git's defaults — three lines of context, rename
detection on. Do not pass `-U0`, `--word-diff`, `--function-context`, `--stat`, or anything else
that changes how hunks are split: the ordinals you write must match the ones vsdiff computes, and
it computes them from the default three lines of context. Binary and other non-textual changes get
exactly one synthetic hunk, `<path>:h1`.

If a path itself contains something that looks like a suffix, the **last** `:h<digits>` is the
separator: `a:h2b.ts:h1` is hunk 1 of the file named `a:h2b.ts`. Nothing else needs escaping.

Examples: `src/auth/middleware.ts:h2`, `pnpm-lock.yaml:h1`.

## Chapters

`chapters[]` are conceptual groups in display order — 1 to 6 of them. A chapter is an idea, not
a file: `"Middleware"`, `"Migration"`, `"Tests"`, `"Cleanup"`. Order them by **review leverage** —
what the reviewer must understand first to judge the rest — never by file path or alphabetically.
One- and two-file changes usually want a single chapter. Every chapter needs a unique `id`, a
short `title`, an optional one-sentence `blurb`, an optional `priority` (see below), and `stops`.

## Stops

A stop is **one review idea**, with prose and the hunks or lines it is about. Budget the whole
session:

- tiny change: 1–3 stops
- focused change: 3–5
- medium change: 5–9
- large change: 7–12

Past a dozen the path stops being a path. If you are over, merge stops that share an idea or move
mechanical hunks into `support` — do not make one stop per file, and do not make one stop per
hunk. Several hunks belong in one stop when they implement the same idea, invariant, or repeated
pattern; cross-file and out-of-order ids are fine and often better.

Each stop carries:

- `id` — unique across the **whole** session, not just its chapter. Feedback events and deep
  links address stops by id, so use a stable slug like `refresh-race`.
- `kind` — `walkthrough` (the default) explains the change; `finding` reports a problem;
  `question` asks the author something you could not resolve from the diff; `verify` asks the
  reviewer to check something you cannot check yourself.
- `severity` — `info` | `minor` | `major` | `blocker`, and **only on a `finding`**. Putting a
  severity on any other kind is an error.
- `priority` — `must` | `nice`, overriding the chapter's. Unset inherits the chapter, and an unset
  chapter is `must` (see below).
- `title` — a semantic 2–6 word phrase, at most 100 characters: `"Concurrent refresh can
double-issue tokens"`. Never a filename or a path.
- `prose` — one or two specific sentences. Inline markdown only: backticks for symbols, paths,
  and flags. No headings, no lists, no block structure.
- `hunkIds` and/or `anchors` — every stop must point at something (see below).
- `suggestion` — optional `{ "patch": "<unified diff>" }` when you have a concrete fix.
- `checks` — optional short list of things the reviewer should confirm.

### Pointing at code

`hunkIds` covers changed code. `anchors` covers anything, including code the diff never touched —
the "look at this caller" case:

```json
{
  "path": "src/api/client.ts",
  "side": "head",
  "start": 88,
  "end": 96,
  "context": "await refreshToken()"
}
```

`side` is `head` for line numbers in the new version of the file, `base` for the old one; lines
are 1-based and inclusive. Always include `context` — a snippet from those lines is what lets
vsdiff relocate the anchor after the file moves.

A stop with neither `hunkIds` nor `anchors` is rejected: it would leave the reviewer nowhere.

### Priority: `must` and `nice`

A chapter may carry `"priority": "must" | "nice"`, and a stop may carry its own, which overrides
its chapter's. **Unset means `must`** — nothing becomes skippable by accident.

The tier says how a reviewer skimming a big change should treat the stop, not how proud you are of
the code:

- `must` — user-facing behavior, hard to reverse (migrations, data writes, public API, wire
  formats), touching security, money, or user data, or a wide blast radius. Anything that needs a
  verdict before the change lands.
- `nice` — internal-facing, easily reversible, low blast radius: dev scripts, admin-page tweaks,
  generated code, mechanical renames. A useful FYI, not a gate.

When the two pull in different directions, `must` wins; when you are unsure, leave it unset.
Marking something `nice` is a claim about blast radius, so **say why in one line** — in the
chapter's `blurb` or the stop's `prose`:

```json
{
  "id": "tooling",
  "title": "Dev scripts",
  "priority": "nice",
  "blurb": "Local harness only — nothing ships to users and reverting is one commit.",
  "stops": [
    {
      "id": "shot-dir",
      "priority": "nice",
      "prose": "Screenshots move to `.dev/shots/`; only the e2e harness reads that path.",
      "hunkIds": ["scripts/e2e.mjs:h1"]
    }
  ]
}
```

A session where every tier you set is `nice` is legal, but ask yourself whether the change really
needs no verdict at all.

## Support, and the hunks you leave out

`support[]` holds changed hunks that should stay off the main path: lockfiles, generated code,
snapshots, mechanical renames, formatting. Each group is `{ "id", "reason", "hunkIds" }` with an
optional `note`.

You do not have to enumerate everything. Any changed hunk the session never mentions is collected
automatically into an **uncovered** group, which the reviewer sees alongside your path. Curating
attention is your job; hiding changes is not something the format allows. Use `support` when
naming _why_ a pile of hunks is boring helps the reviewer skip it faster.

A hunk belongs in exactly one place — one stop or one support group, never both, never twice.

## Rules

- Do not invent findings, risks, or tests. Report only what the diff and the conversation that
  produced it actually support. A walkthrough with zero findings is a normal, good result.
- Do not restate the diff. If a stop's prose could be replaced by reading the hunk, cut the stop.
- Avoid filler, hedging, and meta-labels ("this section covers…"). One concrete sentence beats
  three careful ones.
- Never put a file path in a stop or chapter title — the outline already shows the files.
- Unknown fields are preserved, and `x-` prefixed keys are reserved for your own experiments; the
  editor ignores them.
- If a PR or issue description is available, use it as author intent only. The diff is the truth.

### Anchors and the one-place rule

The "every hunk lives in exactly one stop or support group" rule applies to `hunkIds`
only. A brand-new file is a single hunk (`path:h1`), so when one new file deserves two
stops, give the hunk to the primary stop and point the other stop at the relevant lines
with an `anchor` (`side: "head"`, plus a short `context` snippet) — anchors may overlap
lines that a hunk elsewhere already claims. That is the sanctioned pattern, not a
workaround.

## Proposal sessions

Set top-level `"intent": "proposal"` when the session drafts a review of someone else's change
for a human to triage before posting. In that mode your `finding`/`question` stops are draft
review comments (title + prose post verbatim once accepted); `walkthrough`/`verify` stops are
private triage guidance. Put the draft review body in `review.md` next to `session.json`.

## HTML guides

When the outline and stops cannot carry what the reviewer needs — a diagram, a table, a state
machine, a before/after you have to see — attach an HTML guide:

```json
{ "guide": { "html": "guide/index.html" } }
```

The path is relative to the session directory (no leading `/`, no `..`), and the file opens in a
webview beside the diff via **vsdiff: Open HTML Guide** (a button on the review outline). A guide
adds to the review path, it never replaces it: the review must still work from the stops alone,
because guides do not render in an untrusted workspace.

**Self-contained, no network.** A strict CSP blocks every remote request — no CDN scripts, fonts,
stylesheets, images, or `fetch`. Inline your CSS and JS, keep assets beside the HTML inside the
session directory (relative `src=`/`href=` are rewritten to webview uris for you), and use `data:`
URIs for small images. Do not write a `<meta http-equiv="Content-Security-Policy">` of your own —
vsdiff strips it and injects the policy that lets the guide run at all.

**Driving the editor.** vsdiff injects a bridge before `</body>`:

```js
window.vsdiff.openStop('refresh-race'); // stop id, or its 0-based index
window.vsdiff.openFile('src/auth/session.ts', 42); // path, optional 1-based line
window.vsdiff.nextStop();
window.vsdiff.prevStop();
window.vsdiff.state; // { title, stops: [{ id, index, title, kind }], currentIndex }
```

Plain links do the same without any script:

```html
<a href="vsdiff://stop/refresh-race">the refresh race</a>
<a href="vsdiff://file/src/auth/session.ts:42">session.ts:42</a>
```

`state` is a read-only mirror, refreshed whenever the reviewer moves; listen for the `vsdiff:state`
window event (`event.detail` is the new state) to re-render. Do not call `acquireVsCodeApi()`
yourself — vsdiff already did, and it may only be called once.

**Trusted workspaces only.** A guide is repository content that runs scripts, so it renders with
exactly the trust of the repo: in Restricted Mode the panel shows a short explainer and a link to
grant trust, and none of your HTML reaches the webview.

**Stay theme-agnostic.** The webview inherits the reviewer's theme as CSS variables — style with
`var(--vscode-foreground)`, `var(--vscode-editor-background)`, `var(--vscode-textLink-foreground)`,
`var(--vscode-font-family)`, and friends. Never hard-code colors: half your readers are on a light
theme, and a guide that assumes dark is unreadable for them.

## Length budgets (enforced by `vsdiff validate`)

Everything below renders in the outline tree or must stay skimmable. Overruns are
validation errors, not warnings — keep sessions concise and put detail where it
belongs (stop prose, or more stops).

| Field            | Max chars |
| ---------------- | --------- |
| session `title`  | 80        |
| session `focus`  | 240       |
| chapter `title`  | 24        |
| chapter `blurb`  | 140       |
| stop `title`     | 72        |
| stop `prose`     | 2000      |
| support `reason` | 48        |
| support `note`   | 140       |
| `commit.title`   | 72        |

## Example

```json
{
  "version": 1,
  "kind": "review",
  "title": "Auth flow refactor",
  "focus": "Token refresh moved into middleware; watch session invalidation.",
  "source": { "type": "range", "base": "main", "head": "HEAD" },
  "chapters": [
    {
      "id": "core",
      "title": "Middleware",
      "blurb": "Where the behavior actually changes.",
      "stops": [
        {
          "id": "mw-shape",
          "title": "New refresh pipeline",
          "prose": "Read this before the handlers; everything downstream assumes `withRefresh` has already run.",
          "hunkIds": ["src/auth/middleware.ts:h1"]
        },
        {
          "id": "refresh-race",
          "kind": "finding",
          "severity": "major",
          "title": "Concurrent refresh can double-issue tokens",
          "prose": "Both callers read `expiresAt` before either writes, so two parallel 401s each mint a token.",
          "hunkIds": ["src/auth/middleware.ts:h2", "src/auth/session.ts:h1"],
          "anchors": [
            {
              "path": "src/api/client.ts",
              "side": "head",
              "start": 88,
              "end": 96,
              "context": "await refreshToken()"
            }
          ],
          "checks": ["Confirm single-flight behavior under two parallel 401s"]
        }
      ]
    },
    {
      "id": "tests",
      "title": "Tests",
      "stops": [
        {
          "id": "expiry-coverage",
          "kind": "verify",
          "title": "Expiry cases now covered",
          "prose": "The new cases pin the boundary at `expiresAt - skew`; check the skew matches the server's.",
          "hunkIds": ["test/auth.test.ts:h1", "test/auth.test.ts:h2"]
        }
      ]
    }
  ],
  "support": [{ "id": "lockfile", "reason": "generated", "hunkIds": ["pnpm-lock.yaml:h1"] }]
}
```

Optional top-level fields not shown: `guide` (`{ "html": "guide/index.html" }`, a session-relative
path to an HTML guide you author), `intent` (`"proposal"` when the stops are draft review comments
awaiting the user's triage), `commit` (`{ "title", "body" }` to propose a commit message for a
working-tree session), and `pr` (`{ "number", "headSha" }` for a GitHub-sourced session).

Validate with `vsdiff validate <file>` and fix every reported issue before opening.
