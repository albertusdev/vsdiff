// Argument parsing shared by every verb: `--name value` or `--name` (boolean).
// Errors carry no verb prefix — the dispatcher adds `vsdiff <verb>: `.

export interface ParsedArgs {
  flags: Map<string, string | true>;
  positional: string[];
}

/** A user mistake (missing or malformed flag): reported as a message, never as a stack. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function parseFlags(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { flags, positional };
}

/** The value of `--name`, or undefined when absent or given without one. */
export function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function requireStringFlag(flags: Map<string, string | true>, name: string): string {
  const value = stringFlag(flags, name);
  if (value === undefined || value.length === 0) {
    throw new UsageError(`missing --${name} <value>`);
  }
  return value;
}

/** A non-negative number flag with a default — used for `--after` and `--timeout`. */
export function numberFlag(
  flags: Map<string, string | true>,
  name: string,
  fallback: number,
): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (raw === true) throw new UsageError(`missing value for --${name}`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError(`--${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

/** A required 1-based integer — used for `--line`. */
export function requireIntFlag(flags: Map<string, string | true>, name: string): number {
  const raw = flags.get(name);
  if (raw === undefined || raw === true) throw new UsageError(`missing --${name} <n>`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
