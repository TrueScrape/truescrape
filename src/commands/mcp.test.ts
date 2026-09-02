import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../client.js';
import type { Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { bridgeLine, register } from './mcp.js';

type Call = { url: string; init: RequestInit; body: string };

function stub(responder: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {}, body: String(init?.body ?? '') };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = 'https://api.example';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthorised = () => json({ success: false, error: { code: 'invalid_api_key', message: 'Unrecognised key.' } }, 401);

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

/** Runs `truescrape mcp` end to end: lines in on stdin, whatever it wrote on stdout back out. */
async function bridge(lines: string[], fetchImpl: typeof fetch, env: Record<string, string> = { TRUESCRAPE_API_KEY: 'k' }) {
  const written: string[] = [];
  const stdout = new Writable({ write(chunk, _enc, cb) { written.push(String(chunk)); cb(); } });
  const stdin = Readable.from([lines.join('\n')]);
  const streams = capture();
  const configFile = join(mkdtempSync(join(tmpdir(), 'ts-mcp-')), 'config.json');
  const program = buildProgram([(p) => register(p, { env: { ...env, TRUESCRAPE_BASE_URL: BASE }, configFile, streams, fetchImpl, stdin, stdout })]);
  program.exitOverride();
  await program.parseAsync(['node', 'truescrape', 'mcp']);
  return { stdout: written.join(''), lines: written.join('').split('\n').filter(Boolean), streams };
}

const client = (fetchImpl: typeof fetch) => new Client({ baseUrl: BASE, apiKey: 'k', fetchImpl });
const parse = (line: string) => JSON.parse(line) as { jsonrpc: string; id: unknown; error?: { code: number; message: string; data: { code: string; status?: number } } };

afterEach(() => {
  process.exitCode = undefined;
});

describe('truescrape mcp', () => {
  it('posts an initialize request verbatim with the key and echoes the result as one line', async () => {
    const request = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}';
    const result = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'truescrape' } } };
    const { fetchImpl, calls } = stub(() => json(result));

    const { stdout } = await bridge([request], fetchImpl);

    expect(calls[0]?.url).toBe(`${BASE}/mcp`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.body).toBe(request);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    expect(headers['content-type']).toBe('application/json');
    expect(stdout).toBe(`${JSON.stringify(result)}\n`);
  });

  it('writes nothing for a notification the server acknowledges with an empty 202', async () => {
    const { fetchImpl, calls } = stub(() => new Response(null, { status: 202 }));
    const { stdout } = await bridge(['{"jsonrpc":"2.0","method":"notifications/initialized"}'], fetchImpl);
    expect(calls.length).toBe(1);
    expect(stdout).toBe('');
  });

  it('round-trips a batch as one line', async () => {
    const responses = [{ jsonrpc: '2.0', id: 'a', result: {} }, { jsonrpc: '2.0', id: 'b', result: {} }];
    const { fetchImpl } = stub(() => json(responses));
    const { lines } = await bridge(['[{"jsonrpc":"2.0","id":"a","method":"ping"},{"jsonrpc":"2.0","id":"b","method":"ping"}]'], fetchImpl);
    expect(lines).toEqual([JSON.stringify(responses)]);
  });

  it('turns the 401 envelope into a JSON-RPC error carrying the API code and the request id', async () => {
    const { fetchImpl } = stub(unauthorised);
    const { lines } = await bridge(['{"jsonrpc":"2.0","id":7,"method":"tools/list"}'], fetchImpl);
    expect(lines.length).toBe(1);
    expect(parse(lines[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32000, message: 'Unrecognised key.', data: { code: 'invalid_api_key', status: 401 } },
    });
  });

  it('reports a non-JSON 502 body as upstream_unavailable naming the status and base URL', async () => {
    const { fetchImpl } = stub(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const { lines } = await bridge(['{"jsonrpc":"2.0","id":"x","method":"tools/list"}'], fetchImpl);
    expect(parse(lines[0]!)).toMatchObject({ id: 'x', error: { code: -32000, message: `HTTP 502 from ${BASE}`, data: { code: 'upstream_unavailable', status: 502 } } });
  });

  it('answers a failed batch with one error per element that has an id', async () => {
    const { fetchImpl } = stub(unauthorised);
    const batch = '[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":"two","method":"ping"}]';
    const { lines } = await bridge([batch], fetchImpl);
    expect(lines.length).toBe(1);
    const errors = JSON.parse(lines[0]!) as unknown[];
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ jsonrpc: '2.0', id: 1, error: { data: { code: 'invalid_api_key' } } });
    expect(errors[1]).toMatchObject({ jsonrpc: '2.0', id: 'two', error: { data: { code: 'invalid_api_key' } } });
  });

  it('writes nothing when a notification fails, since there is no id to answer', async () => {
    const { fetchImpl } = stub(unauthorised);
    const { stdout } = await bridge(['{"jsonrpc":"2.0","method":"notifications/initialized"}'], fetchImpl);
    expect(stdout).toBe('');
  });

  it('shapes an unreachable server as a network error', async () => {
    const { fetchImpl } = stub(() => {
      throw new TypeError('fetch failed');
    });
    const { lines } = await bridge(['{"jsonrpc":"2.0","id":3,"method":"ping"}'], fetchImpl);
    expect(parse(lines[0]!)).toMatchObject({ id: 3, error: { code: -32000, data: { code: 'network' } } });
    expect(parse(lines[0]!).error?.message).toContain(`${BASE}/mcp`);
    expect(parse(lines[0]!).error?.data).not.toHaveProperty('status');
  });

  it('writes a pretty-printed response as exactly one line', async () => {
    const result = { jsonrpc: '2.0', id: 1, result: { text: 'line one\nline two' } };
    const { fetchImpl } = stub(() => new Response(JSON.stringify(result, null, 2), { status: 200 }));
    const { stdout, lines } = await bridge(['{"jsonrpc":"2.0","id":1,"method":"ping"}'], fetchImpl);
    expect(lines).toHaveLength(1);
    expect(stdout).toBe(`${JSON.stringify(result)}\n`);
  });

  it('keeps diagnostics on stderr and only JSON-RPC lines on stdout', async () => {
    const { fetchImpl } = stub((_call, index) => (index === 0 ? unauthorised() : json({ jsonrpc: '2.0', id: 2, result: {} })));
    const { lines, streams } = await bridge(['{"jsonrpc":"2.0","id":1,"method":"ping"}', '', '{"jsonrpc":"2.0","id":2,"method":"ping"}'], fetchImpl);
    expect(streams.err.length).toBeGreaterThan(0);
    expect(streams.err.join('')).toContain('invalid_api_key');
    expect(streams.out).toEqual([]);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(parse(line).jsonrpc).toBe('2.0');
  });

  it('exits 2 with an empty stdout when there is no key', async () => {
    const { fetchImpl, calls } = stub(() => json({}));
    const { stdout, streams } = await bridge(['{"jsonrpc":"2.0","id":1,"method":"ping"}'], fetchImpl, {});
    expect(process.exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(calls).toHaveLength(0);
    expect(streams.err.join('')).toContain('TRUESCRAPE_API_KEY');
  });

  it('processes messages one at a time in stdin order', async () => {
    const order: string[] = [];
    const { fetchImpl } = stub(async (call) => {
      const id = (JSON.parse(call.body) as { id: number }).id;
      order.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, id === 1 ? 30 : 0));
      order.push(`end ${id}`);
      return json({ jsonrpc: '2.0', id, result: {} });
    });
    const { lines } = await bridge(['{"jsonrpc":"2.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":2,"method":"ping"}'], fetchImpl);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    expect(lines.map((l) => parse(l).id)).toEqual([1, 2]);
  });
});

describe('bridgeLine', () => {
  it('returns null for an empty 2xx body even when the request had an id', async () => {
    const { fetchImpl } = stub(() => new Response('', { status: 200 }));
    expect(await bridgeLine('{"jsonrpc":"2.0","id":5,"method":"ping"}', client(fetchImpl), BASE)).toBeNull();
  });

  it('forwards a JSON-RPC error body the server sends with a non-2xx status', async () => {
    const parseError = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    const { fetchImpl } = stub(() => json(parseError, 400));
    expect(await bridgeLine('{not json', client(fetchImpl), BASE)).toBe(JSON.stringify(parseError));
  });

  it('answers with id null when the input line was not JSON and the server gave no JSON-RPC body', async () => {
    const { fetchImpl } = stub(() => new Response('<html>503</html>', { status: 503 }));
    const line = await bridgeLine('{not json', client(fetchImpl), BASE);
    expect(JSON.parse(line!)).toMatchObject({ jsonrpc: '2.0', id: null, error: { data: { code: 'upstream_unavailable', status: 503 } } });
  });

  it('never lets a non-JSON 2xx body reach stdout as prose', async () => {
    const { fetchImpl } = stub(() => new Response('<html>ok</html>', { status: 200 }));
    const line = await bridgeLine('{"jsonrpc":"2.0","id":9,"method":"ping"}', client(fetchImpl), BASE);
    expect(JSON.parse(line!)).toMatchObject({ id: 9, error: { data: { code: 'upstream_unavailable', status: 200 } } });
  });
});
