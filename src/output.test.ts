import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './client.js';
import { EXIT, UsageError, emit, flatten, formatData, isEmptyData, listOf, metaLine, reportError, type OutputOptions, type Streams } from './output.js';

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

const base: OutputOptions = { format: 'json', pretty: false, envelope: false, quiet: false, color: false };

describe('formatData', () => {
  it('prints compact JSON by default and indented with pretty', () => {
    expect(formatData({ a: 1 }, 'json', false)).toBe('{"a":1}');
    expect(formatData({ a: 1 }, 'json', true)).toBe('{\n  "a": 1\n}');
  });

  it('flattens an object to key/value rows and an array of objects to columns', () => {
    expect(flatten({ a: 1, b: { c: 2 } })).toEqual({ columns: ['key', 'value'], rows: [{ key: 'a', value: '1' }, { key: 'b', value: '{"c":2}' }] });
    expect(flatten([{ a: 1 }, { a: 2, b: 'x' }])).toEqual({ columns: ['a', 'b'], rows: [{ a: '1', b: '' }, { a: '2', b: 'x' }] });
  });

  it('escapes csv and markdown', () => {
    expect(formatData([{ t: 'a,"b"' }], 'csv', false)).toBe('t\n"a,""b"""');
    expect(formatData({ k: 'a|b' }, 'markdown', false)).toBe('| key | value |\n| --- | --- |\n| k | a\\|b |');
  });

  it('renders a table', () => {
    const table = formatData([{ name: 'x', n: 1 }], 'table', false);
    expect(table).toContain('name');
    expect(table).toContain('x');
  });
});

describe('metaLine', () => {
  it('names credits, cache state, timing and the cursor hint', () => {
    expect(metaLine({ data: [1], meta: { creditsCharged: 1, cached: false, durationMs: 412, requestId: 'req_1' }, status: 200 })).toBe('1 credit · live fetch · 412 ms · req_1');
    expect(metaLine({ data: [1], meta: { creditsCharged: 0, cached: true }, status: 200 })).toBe('0 credits · cache hit');
    expect(metaLine({ data: { items: [] }, meta: { creditsCharged: 0 }, status: 200 })).toBe('0 credits · empty');
    expect(metaLine({ data: [1], meta: { creditsCharged: 2 }, pagination: { cursor: 'abc', hasMore: true, count: 1 }, status: 200 })).toContain('more: --cursor abc');
  });
});

describe('emptiness mirrors the API wrapper rule', () => {
  it('recognises bare arrays and the wrapper keys', () => {
    expect(listOf([1])).toEqual({ key: null, list: [1] });
    expect(listOf({ items: [] })?.key).toBe('items');
    expect(listOf({ videos: [1] })?.key).toBe('videos');
    expect(listOf({ followerCount: 1 })).toBeNull();
    expect(isEmptyData({ items: [] })).toBe(true);
    expect(isEmptyData({ followerCount: 1 })).toBe(false);
    expect(isEmptyData(null)).toBe(true);
  });
});

describe('emit', () => {
  it('writes data to stdout and the meta line to stderr', () => {
    const s = capture();
    emit({ data: { a: 1 }, meta: { creditsCharged: 1 }, status: 200 }, base, s);
    expect(s.out).toEqual(['{"a":1}\n']);
    expect(s.err).toEqual(['1 credit · live fetch\n']);
  });

  it('wraps in the envelope on request and stays quiet on request', () => {
    const s = capture();
    emit({ data: 1, meta: { creditsCharged: 1 }, pagination: { cursor: null, hasMore: false, count: 1 }, status: 200 }, { ...base, envelope: true, quiet: true }, s);
    expect(JSON.parse(s.out[0] ?? '')).toEqual({ data: 1, meta: { creditsCharged: 1 }, pagination: { cursor: null, hasMore: false, count: 1 } });
    expect(s.err).toEqual([]);
  });

  it('writes to a file and prints only the path', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ts-out-')), 'data.json');
    const s = capture();
    emit({ data: [1, 2], status: 200 }, { ...base, output: path, quiet: true }, s);
    expect(s.out).toEqual([`${path}\n`]);
    expect(readFileSync(path, 'utf8')).toBe('[1,2]\n');
  });
});

describe('reportError', () => {
  it('maps error classes to exit codes and prints one JSON line when piped', () => {
    const s = capture();
    expect(reportError(new ApiError('invalid_api_key', 401, 'Bad key', undefined, 'req_9'), false, s)).toBe(EXIT.api);
    expect(JSON.parse(s.err[0] ?? '')).toEqual({ error: 'invalid_api_key', message: 'Bad key', requestId: 'req_9' });
    expect(reportError(new ApiError('insufficient_credits', 402, 'Top up'), false, s)).toBe(EXIT.api);
    expect(JSON.parse(s.err[1] ?? '').error).toBe('insufficient_credits');
    expect(reportError(new UsageError('missing --handle'), false, s)).toBe(EXIT.usage);
    expect(reportError(new NetworkError('down'), false, s)).toBe(EXIT.network);
    expect(reportError(new Error('boom'), false, s)).toBe(EXIT.api);
  });

  it('prints prose for a person', () => {
    const s = capture();
    reportError(new ApiError('not_configured', 501, 'Set X', { parameter: 'render' }), true, s);
    expect(s.err[0]).toBe('Error (not_configured): Set X\n');
    expect(s.err[1]).toContain('"parameter": "render"');
  });
});
