// Human-readable rendering of the feedback log: one line per event,
// `[ts] type · summary`, plus the resume cursor an agent pastes back as
// `--after <n>`. The machine path (`--json`) prints the core batch verbatim;
// nothing here is on it.

import type { FeedbackBatch, FeedbackEvent } from '@vsdiff/core';

const BODY_MAX = 80;

function fields(event: FeedbackEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

function str(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** One line, at most `max` characters: bodies are prose and often multi-line. */
export function summarizeBody(body: unknown, max = BODY_MAX): string {
  if (typeof body !== 'string') return '';
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function positionOf(event: Record<string, unknown>): string {
  const path = str(event, 'path') ?? '?';
  const line = event.line;
  const side = str(event, 'side');
  const at = typeof line === 'number' ? `${path}:${line}` : path;
  return side === 'base' ? `${at} (base)` : at;
}

function summarize(event: FeedbackEvent): string {
  const f = fields(event);
  switch (event.type) {
    case 'comment': {
      const stop = str(f, 'stop');
      return `${positionOf(f)}${stop === undefined ? '' : ` [${stop}]`} — ${summarizeBody(f.body)}`;
    }
    case 'reply':
      return `→ ${str(f, 'thread') ?? '?'} — ${summarizeBody(f.body)}`;
    case 'verdict':
      return `${str(f, 'stop') ?? '?'} → ${str(f, 'verdict') ?? '?'}`;
    case 'viewed':
      return `${positionOf(f)} — ${f.viewed === false ? 'not viewed' : 'viewed'}`;
    case 'resolve':
      return `→ ${str(f, 'thread') ?? '?'} — resolved by ${str(f, 'by') ?? '?'}`;
    case 'done': {
      const note = summarizeBody(f.note);
      return `${str(f, 'status') ?? '?'}${note === '' ? '' : ` — ${note}`}`;
    }
    default: {
      // Unknown types are passed through by core (D2) and must stay visible.
      const { type: _type, ts: _ts, ...rest } = f;
      return summarizeBody(JSON.stringify(rest));
    }
  }
}

export function formatEvent(event: FeedbackEvent): string {
  const ts = str(fields(event), 'ts') ?? '?';
  return `[${ts}] ${event.type} · ${summarize(event)}`;
}

/** The whole batch as printed by `vsdiff feedback`, resume cursor included. */
export function formatBatch(batch: FeedbackBatch): string {
  const lines = batch.events.map(formatEvent);
  if (lines.length === 0) lines.push('no new feedback');
  if (batch.malformed > 0) lines.push(`note: skipped ${batch.malformed} malformed line(s)`);
  lines.push(`next: --after ${batch.nextLine}`);
  return `${lines.join('\n')}\n`;
}
