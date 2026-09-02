import { writeFileSync } from 'node:fs';
import { styleText } from 'node:util';
import Table from 'cli-table3';
import { ApiError, NetworkError, type Envelope } from './client.js';

export type Format = 'json' | 'table' | 'csv' | 'markdown';
export const FORMATS: Format[] = ['json', 'table', 'csv', 'markdown'];

export interface OutputOptions {
  format: Format;
  pretty: boolean;
  envelope: boolean;
  output?: string;
  quiet: boolean;
  color: boolean;
}

/** A mistake in how the command was called. Exit 2, usage on stderr. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const EXIT = { ok: 0, api: 1, usage: 2, network: 3 } as const;

export function paint(text: string, color: boolean, style: Parameters<typeof styleText>[0]): string {
  return color ? styleText(style, text) : text;
}

type Row = Record<string, string>;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** An object becomes key/value rows; an array of objects becomes one row per element; a scalar is one cell. */
export function flatten(data: unknown): { columns: string[]; rows: Row[] } {
  if (Array.isArray(data)) {
    const objects = data.filter((d) => d && typeof d === 'object' && !Array.isArray(d)) as Record<string, unknown>[];
    if (objects.length === data.length && data.length > 0) {
      const columns = [...new Set(objects.flatMap((o) => Object.keys(o)))];
      return { columns, rows: objects.map((o) => Object.fromEntries(columns.map((c) => [c, cell(o[c])]))) };
    }
    return { columns: ['value'], rows: data.map((d) => ({ value: cell(d) })) };
  }
  if (data && typeof data === 'object') {
    return { columns: ['key', 'value'], rows: Object.entries(data).map(([key, value]) => ({ key, value: cell(value) })) };
  }
  return { columns: ['value'], rows: [{ value: cell(data) }] };
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatData(data: unknown, format: Format, pretty: boolean): string {
  if (format === 'json') return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);

  const { columns, rows } = flatten(data);
  if (format === 'csv') {
    return [columns.map(csvEscape).join(','), ...rows.map((r) => columns.map((c) => csvEscape(r[c] ?? '')).join(','))].join('\n');
  }
  if (format === 'markdown') {
    const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
    return [line(columns), line(columns.map(() => '---')), ...rows.map((r) => line(columns.map((c) => r[c] ?? '')))].join('\n');
  }
  const table = new Table({ head: columns, wordWrap: true, wrapOnWordBoundary: false });
  for (const r of rows) table.push(columns.map((c) => r[c] ?? ''));
  return table.toString();
}

/** The billing facts, one line, for stderr. */
export function metaLine(envelope: Envelope): string {
  const meta = envelope.meta ?? {};
  const credits = meta.creditsCharged ?? 0;
  const parts = [`${credits} credit${credits === 1 ? '' : 's'}`];
  if (meta.cached) parts.push('cache hit');
  else if (isEmptyData(envelope.data)) parts.push('empty');
  else parts.push('live fetch');
  if (typeof meta.durationMs === 'number') parts.push(`${meta.durationMs} ms`);
  if (meta.requestId) parts.push(meta.requestId);
  if (envelope.pagination?.hasMore && envelope.pagination.cursor) parts.push(`more: --cursor ${envelope.pagination.cursor}`);
  return parts.join(' · ');
}

const WRAPPER_KEYS = ['items', 'results', 'posts', 'comments', 'ads', 'videos'] as const;

/** Mirrors the API's own emptiness rule: a bare array, or the first wrapper key it recognises. */
export function listOf(data: unknown): { key: string | null; list: unknown[] } | null {
  if (Array.isArray(data)) return { key: null, list: data };
  if (data && typeof data === 'object') {
    for (const key of WRAPPER_KEYS) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return { key, list: value };
    }
  }
  return null;
}

export function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  const found = listOf(data);
  return found !== null && found.list.length === 0;
}

export interface Streams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const processStreams: Streams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** Data to stdout (or a file, printing only its path); the billing line to stderr. */
export function emit(envelope: Envelope, options: OutputOptions, streams: Streams = processStreams): void {
  const payload = options.envelope
    ? { data: envelope.data, meta: envelope.meta ?? null, pagination: envelope.pagination ?? null }
    : envelope.data;
  const text = formatData(payload, options.format, options.pretty);

  if (options.output) {
    writeFileSync(options.output, `${text}\n`);
    streams.stdout(`${options.output}\n`);
  } else {
    streams.stdout(`${text}\n`);
  }
  if (!options.quiet) streams.stderr(`${paint(metaLine(envelope), options.color, 'dim')}\n`);
}

/** Every failure goes to stderr as one JSON line for pipes, or prose for a person. Returns the exit code. */
export function reportError(err: unknown, isTTY: boolean, streams: Streams = processStreams, color = false): number {
  if (err instanceof UsageError) {
    streams.stderr(isTTY ? `${paint('Usage error:', color, 'red')} ${err.message}\n` : `${JSON.stringify({ error: 'usage', message: err.message })}\n`);
    return EXIT.usage;
  }
  if (err instanceof ApiError) {
    if (isTTY) {
      streams.stderr(`${paint(`Error (${err.code})`, color, 'red')}: ${err.message}${err.requestId ? ` [${err.requestId}]` : ''}\n`);
      if (err.details !== undefined) streams.stderr(`${JSON.stringify(err.details, null, 2)}\n`);
    } else {
      streams.stderr(`${JSON.stringify({ error: err.code, message: err.message, details: err.details, requestId: err.requestId })}\n`);
    }
    return EXIT.api;
  }
  if (err instanceof NetworkError) {
    streams.stderr(isTTY ? `${paint('Network error:', color, 'red')} ${err.message}\n` : `${JSON.stringify({ error: 'network', message: err.message })}\n`);
    return EXIT.network;
  }
  const message = err instanceof Error ? err.message : String(err);
  streams.stderr(isTTY ? `${paint('Error:', color, 'red')} ${message}\n` : `${JSON.stringify({ error: 'internal', message })}\n`);
  return EXIT.api;
}
