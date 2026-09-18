import type { Severity, StopKind } from '@vsdiff/schema';

// Label chips for native comment bodies (dogfood round 4: stop metadata read as
// a throwaway italic line). A vscode.Comment body is a MarkdownString with no
// HTML, but the workbench markdown renderer keeps `data:` image sources — so a
// GitHub-style pill is a tiny inline SVG behind a markdown image. Alt text is
// the label itself, so a blocked image still reads as the word it stands for.
//
// The palette is GitHub's label mid-tones: dark enough for white text on a
// light theme, bright enough to stay legible on a dark one. Chips paint their
// own background, so they do not follow the workbench theme — keep the values.

export const KIND_COLOR: Record<StopKind, string> = {
  walkthrough: '#57606a',
  finding: '#cf222e', // an unranked finding reads as major, matching the outline
  question: '#8250df',
  verify: '#1a7f37',
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  info: '#0969da',
  minor: '#bf8700',
  major: '#cf222e',
  blocker: '#82071e',
};

export type StateColorName = 'neutral' | 'accepted' | 'edited' | 'dropped' | 'pending';

export const STATE_COLOR: Record<StateColorName, string> = {
  neutral: '#57606a',
  accepted: '#1a7f37',
  edited: '#0969da',
  dropped: '#6e7781',
  pending: '#bf8700',
};

const HEIGHT = 18;
const MIN_WIDTH = 30;
const MAX_WIDTH = 260;

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A pill-shaped label: `text` in white on `background`, as a markdown image. */
export function chip(text: string, background: string): string {
  const width = Math.min(Math.max(Math.round(text.length * 7 + 14), MIN_WIDTH), MAX_WIDTH);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" ` +
    `viewBox="0 0 ${width} ${HEIGHT}">` +
    `<rect width="${width}" height="${HEIGHT}" rx="4" fill="${background}"/>` +
    `<text x="${width / 2}" y="13" fill="#ffffff" text-anchor="middle" ` +
    `font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="11" ` +
    `font-weight="600">${escapeXml(text)}</text>` +
    `</svg>`;
  // Parentheses survive encodeURIComponent but would close the markdown image's
  // URL early, so they are escaped by hand.
  const encoded = encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `![${text}](data:image/svg+xml,${encoded})`;
}

/** Findings are coloured by severity; every other kind by its own hue. */
export function kindColor(kind: StopKind | undefined, severity: Severity | undefined): string {
  const resolved = kind ?? 'walkthrough';
  if (resolved === 'finding' && severity) return SEVERITY_COLOR[severity] ?? KIND_COLOR.finding;
  return KIND_COLOR[resolved] ?? KIND_COLOR.walkthrough;
}

/** The metadata line above a stop's prose: kind, severity, and where you are.
 *  `position` is the already-formatted position text, e.g. `stop 4/8`. */
export function stopChips(
  kind: StopKind | undefined,
  severity: Severity | undefined,
  position: string,
): string {
  const chips = [chip(kind ?? 'walkthrough', kindColor(kind, severity))];
  if (severity) chips.push(chip(severity, SEVERITY_COLOR[severity] ?? KIND_COLOR.finding));
  chips.push(chip(position, STATE_COLOR.neutral));
  return chips.join(' ');
}
