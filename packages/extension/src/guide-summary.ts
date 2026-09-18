/** Long guide text starts with a short excerpt; the full source stays intact. */
export function guideSummary(prose: string): string | null {
  const text = prose.trim();
  if (text.length <= 240) return null;
  const first = text.split(/\n\s*\n/)[0] ?? text;
  if (first.length <= 240) return `${first} …`;
  const excerpt = first.slice(0, 240);
  const boundary = excerpt.lastIndexOf(' ');
  return `${excerpt.slice(0, boundary > 160 ? boundary : 240).trimEnd()}…`;
}
