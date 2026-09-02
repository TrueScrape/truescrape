import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError, type Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledCatalogue, findEndpoint } from '../catalogue.js';
import type { Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { dynamicDispatch, mergePage, queryFromOptions, register } from './endpoints.js';

type Call = { url: string; init: RequestInit };

function stub(responder: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ok = (data: unknown, extra: Record<string, unknown> = {}) => json({ success: true, data, meta: { creditsCharged: 1 }, ...extra });

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'ts-ep-'));

interface ExecOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  cacheFile?: string;
}

/** Runs one argv through a fresh program and reports what came out and how it ended. */
async function exec(argv: string[], options: ExecOptions = {}) {
  const dir = tmp();
  const streams = capture();
  const env = options.env ?? { TRUESCRAPE_API_KEY: 'k', TRUESCRAPE_BASE_URL: 'https://api.example' };
  const overrides = {
    env,
    configFile: join(dir, 'config.json'),
    cacheFile: options.cacheFile ?? join(dir, 'cache.json'),
    streams,
    fetchImpl: options.fetchImpl ?? stub(() => ok({})).fetchImpl,
    isTTY: options.isTTY ?? false,
  };
  const program = buildProgram([(p) => register(p, overrides)]);
  // Commander copies these into a subcommand when it is created, so they must be applied to the whole tree.
  const silence = (cmd: Command) => {
    cmd.exitOverride().configureOutput({ writeOut: (s) => streams.err.push(s), writeErr: (s) => streams.err.push(s) });
    for (const sub of cmd.commands) silence(sub);
  };
  silence(program);

  let thrown: unknown;
  try {
    await program.parseAsync(['node', 'truescrape', ...argv]);
    await dynamicDispatch(program);
  } catch (err) {
    thrown = err;
  }
  const code = thrown instanceof CommanderError ? thrown.exitCode : (process.exitCode ?? 0);
  return { program, streams, code, thrown, stdout: streams.out.join(''), stderr: streams.err.join('') };
}

function buildOnly() {
  const program = buildProgram([(p) => register(p, { env: {}, configFile: join(tmp(), 'c.json') })]);
  program.exitOverride();
  return program;
}

const fixture = () => JSON.parse(readFileSync(new URL('../../test/fixtures/openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, unknown> };

afterEach(() => {
  process.exitCode = undefined;
});

describe('registration', () => {
  it('registers every bundled endpoint exactly once under its platform', () => {
    const program = buildOnly();
    const seen = new Map<string, number>();
    for (const platform of program.commands) {
      for (const action of platform.commands) {
        const key = `${platform.name()} ${action.name()}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const expected = bundledCatalogue().endpoints.map((e) => `${e.platform} ${e.action}`);
    expect(seen.size).toBe(expected.length);
    for (const key of expected) expect(seen.get(key), key).toBe(1);
  });

  it('has the action-less endpoints and the nested reddit path under plain names', () => {
    const program = buildOnly();
    const has = (platform: string, action: string) =>
      program.commands.find((c) => c.name() === platform)?.commands.some((c) => c.name() === action) ?? false;
    for (const platform of ['linktree', 'komi', 'linkbio', 'linkme', 'pillar']) expect(has(platform, 'page'), platform).toBe(true);
    expect(has('inference', 'age-gender')).toBe(true);
    expect(has('reddit', 'post-comment-replies')).toBe(true);
  });

  it('describes cost, constraints and the experimental flag', () => {
    const program = buildOnly();
    const find = (platform: string, action: string) =>
      program.commands.find((c) => c.name() === platform)?.commands.find((c) => c.name() === action) as Command;
    const constrained = bundledCatalogue().endpoints.find((e) => e.constraints.length > 0);
    const experimental = bundledCatalogue().endpoints.find((e) => e.experimental);
    expect(constrained && experimental).toBeTruthy();
    const c = find(constrained!.platform, constrained!.action).description();
    expect(c).toContain(constrained!.summary);
    expect(c).toMatch(/Costs \d+ credits?\./);
    for (const line of constrained!.constraints) expect(c).toContain(line);
    expect(find(experimental!.platform, experimental!.action).description()).toContain('(experimental)');
    expect(find('youtube', 'channel-videos').description()).not.toContain('(experimental)');
  });

  it('turns every catalogue param into a flag, with --no- for booleans and choices for enums', () => {
    const program = buildOnly();
    const cmd = program.commands.find((c) => c.name() === 'youtube')?.commands.find((c) => c.name() === 'channel-videos') as Command;
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--handle', '--tab', '--cache-max-age', '--include-raw', '--no-include-raw']));
    expect(cmd.options.find((o) => o.long === '--tab')?.argChoices).toEqual(['videos', 'shorts', 'streams']);
  });
});

describe('queryFromOptions', () => {
  const endpoint = findEndpoint(bundledCatalogue(), 'reddit', 'post-comment-replies')!;

  it('keys by param name, parses numbers and drops what was not set', () => {
    expect(queryFromOptions(endpoint, { url: 'a:b', depth: '3', includeRaw: undefined, all: true })).toEqual({ url: 'a:b', depth: 3 });
  });

  it('rejects a non-number with a usage error naming the flag', () => {
    expect(() => queryFromOptions(endpoint, { url: 'a:b', depth: 'deep' })).toThrow(/--depth/);
  });

  it('lists every missing required flag', () => {
    const two = findEndpoint(bundledCatalogue(), 'youtube', 'channel-videos')!;
    expect(() => queryFromOptions(two, {})).toThrow(/--handle/);
    const search = { ...two, params: [...two.params, { name: 'query', flag: 'query', type: 'string' as const, required: true }] };
    expect(() => queryFromOptions(search, {})).toThrow(/--handle.*--query/);
  });
});

describe('calling an endpoint', () => {
  it('builds the URL from the flags that were set and emits the data', async () => {
    const { fetchImpl, calls } = stub(() => ok({ items: [{ id: 'v1' }] }));
    const { code, stdout, stderr } = await exec(['youtube', 'channel-videos', '--handle', '@x', '--tab', 'shorts'], { fetchImpl });
    expect(code).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(['https://api.example/v1/youtube/channel-videos?handle=%40x&tab=shorts']);
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(stdout)).toEqual({ items: [{ id: 'v1' }] });
    expect(stderr).toMatch(/1 credit/);
  });

  it('does not send a default the user never typed, and maps a hyphenated flag back to its param', async () => {
    const { fetchImpl, calls } = stub(() => ok({ items: [1] }));
    await exec(['youtube', 'channel-videos', '--handle', 'x', '--cache-max-age', '60'], { fetchImpl });
    expect(calls[0]?.url).toBe('https://api.example/v1/youtube/channel-videos?handle=x&cache_max_age=60');
  });

  it('sends include_raw=true for --include-raw and false for --no-include-raw', async () => {
    const on = stub(() => json({ success: true, data: { a: 1 }, raw: { upstream: true }, meta: { creditsCharged: 1 } }));
    const { stdout } = await exec(['linktree', 'page', '--url', 'u', '--include-raw'], { fetchImpl: on.fetchImpl });
    expect(on.calls[0]?.url).toBe('https://api.example/v1/linktree?url=u&include_raw=true');
    // raw sits beside data in the response, so printing data alone would drop what was asked for.
    expect(JSON.parse(stdout)).toMatchObject({ data: { a: 1 }, raw: { upstream: true } });
    const off = stub(() => ok({ a: 1 }));
    await exec(['linktree', 'page', '--url', 'u', '--no-include-raw'], { fetchImpl: off.fetchImpl });
    expect(off.calls[0]?.url).toBe('https://api.example/v1/linktree?url=u&include_raw=false');
  });

  it('parses a number flag and refuses a non-number before any request', async () => {
    const good = stub(() => ok({ items: [1] }));
    await exec(['reddit', 'post-comment-replies', '--url', 'a:b', '--depth', '3'], { fetchImpl: good.fetchImpl });
    expect(good.calls[0]?.url).toBe('https://api.example/v1/reddit/post/comment/replies?url=a%3Ab&depth=3');

    const bad = stub(() => ok({ items: [1] }));
    const { code, stdout, stderr } = await exec(['reddit', 'post-comment-replies', '--url', 'a:b', '--depth', 'deep'], { fetchImpl: bad.fetchImpl });
    expect(code).toBe(2);
    expect(bad.calls).toHaveLength(0);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/--depth/);
  });

  it('is a usage error listing the missing required flags, with no request made', async () => {
    const { fetchImpl, calls } = stub(() => ok({ items: [1] }));
    const { code, stdout, stderr } = await exec(['youtube', 'channel-videos'], { fetchImpl });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/--handle/);
  });

  it('rejects a value outside the enum with exit 2 and no request', async () => {
    const { fetchImpl, calls } = stub(() => ok({ items: [1] }));
    const { code, stderr } = await exec(['youtube', 'channel-videos', '--handle', 'x', '--tab', 'reels'], { fetchImpl });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(stderr).toMatch(/videos, shorts, streams/);
  });

  it('needs a key before it will make a request', async () => {
    const { fetchImpl, calls } = stub(() => ok({ items: [1] }));
    const { code, stderr } = await exec(['youtube', 'channel-videos', '--handle', 'x'], { fetchImpl, env: { TRUESCRAPE_BASE_URL: 'https://api.example' } });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(stderr).toMatch(/TRUESCRAPE_API_KEY/);
  });
});

describe('mergePage', () => {
  it('concatenates bare arrays and the recognised wrapper key, keeping the first wrapper', () => {
    expect(mergePage([1, 2], [3])).toEqual([1, 2, 3]);
    expect(mergePage({ items: [1], creator: 'c' }, { items: [2], creator: 'd' })).toEqual({ items: [1, 2], creator: 'c' });
    expect(mergePage({ posts: [1] }, { posts: [] })).toEqual({ posts: [1] });
  });
});

describe('--all', () => {
  const page = (n: number, hasMore: boolean, wrap = true) => {
    const data = wrap ? { items: [`p${n}`] } : [`p${n}`];
    return ok(data, { pagination: { cursor: hasMore ? `c${n}` : null, hasMore, count: 1 } });
  };

  const argv = ['rumble', 'channel-videos', '--handle', 'x', '--all'];
  const url = 'https://api.example/v1/rumble/channel/videos?handle=x';

  it('follows the cursor until hasMore is false and merges the wrapper', async () => {
    const { fetchImpl, calls } = stub((_c, i) => page(i + 1, i < 2));
    const { code, stdout, stderr } = await exec(argv, { fetchImpl });
    expect(code).toBe(0);
    expect(calls.map((c) => c.url)).toEqual([url, `${url}&cursor=c1`, `${url}&cursor=c2`]);
    expect(JSON.parse(stdout)).toEqual({ items: ['p1', 'p2', 'p3'] });
    expect(stderr).toContain('page 2 · 1 credit · total 2 credits');
    expect(stderr).toContain('page 3 · 1 credit · total 3 credits');
  });

  it('merges bare arrays too', async () => {
    const { fetchImpl } = stub((_c, i) => page(i + 1, i < 1, false));
    const { stdout } = await exec(argv, { fetchImpl });
    expect(JSON.parse(stdout)).toEqual(['p1', 'p2']);
  });

  it('stops at --max-pages even when more remain', async () => {
    const { fetchImpl, calls } = stub((_c, i) => page(i + 1, true));
    const { code, stdout } = await exec([...argv, '--max-pages', '2'], { fetchImpl });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(stdout)).toEqual({ items: ['p1', 'p2'] });
  });

  it('refuses a result that is not a list, emitting nothing', async () => {
    const { fetchImpl, calls } = stub(() => ok({ id: 'one' }, { pagination: { cursor: 'c', hasMore: true, count: 1 } }));
    const { code, stdout } = await exec(argv, { fetchImpl });
    expect(code).toBe(2);
    expect(calls).toHaveLength(1);
    expect(stdout).toBe('');
  });

  it('emits what it gathered, then exits 1, when a later page fails', async () => {
    const { fetchImpl } = stub((_c, i) => (i === 0 ? page(1, true) : json({ success: false, error: { code: 'upstream_unavailable', message: 'down' } }, 503)));
    const { code, stdout, stderr } = await exec(argv, { fetchImpl });
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ items: ['p1'] });
    expect(stderr).toContain('upstream_unavailable');
  });

  it('is a usage error on an endpoint without a cursor', async () => {
    const { fetchImpl, calls } = stub(() => ok({ items: [1] }));
    const { code, stderr } = await exec(['youtube', 'channel-videos', '--handle', 'x', '--all'], { fetchImpl });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(stderr).toMatch(/does not paginate/);
    const paged = await exec(['google', 'search', '--query', 'q', '--all'], { fetchImpl });
    expect(paged.code).toBe(2);
    expect(paged.stderr).toMatch(/--page/);
  });

  it('rejects a --max-pages that is not a positive integer', async () => {
    const { fetchImpl, calls } = stub(() => ok({ items: [1] }));
    const { code } = await exec([...argv, '--max-pages', '0'], { fetchImpl });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('an endpoint the bundle does not know', () => {
  const specWith = (path: string, operationId: string, tag: string) => {
    const spec = fixture();
    spec.paths[path] = {
      get: {
        operationId,
        summary: 'Brand new',
        tags: [tag],
        'x-credit-cost': 2,
        parameters: [{ name: 'handle', in: 'query', required: true, schema: { type: 'string' } }],
      },
    };
    return spec;
  };

  it('fetches the live catalogue once, registers the endpoint and runs it', async () => {
    const spec = specWith('/v1/youtube/brand-new', 'youtube_brandNew', 'youtube');
    const { fetchImpl, calls } = stub((c) => (c.url.endsWith('/openapi.json') ? json(spec) : ok({ items: ['new'] })));
    const { code, stdout } = await exec(['youtube', 'brand-new', '--handle', 'x'], { fetchImpl });
    expect(code).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(['https://api.example/openapi.json', 'https://api.example/v1/youtube/brand-new?handle=x']);
    expect(JSON.parse(stdout)).toEqual({ items: ['new'] });
  });

  it('handles a platform the bundle has never heard of', async () => {
    const spec = specWith('/v1/newplat/thing', 'newplat_thing', 'newplat');
    const { fetchImpl, calls } = stub((c) => (c.url.endsWith('/openapi.json') ? json(spec) : ok({ items: ['x'] })));
    const { code, stdout } = await exec(['newplat', 'thing', '--handle', 'h', '--pretty'], { fetchImpl });
    expect(code).toBe(0);
    expect(calls.filter((c) => c.url.endsWith('/openapi.json'))).toHaveLength(1);
    expect(calls.at(-1)?.url).toBe('https://api.example/v1/newplat/thing?handle=h');
    expect(stdout).toBe(`${JSON.stringify({ items: ['x'] }, null, 2)}\n`);
  });

  it('is a usage error pointing at `truescrape list` when the live catalogue has no such endpoint', async () => {
    const { fetchImpl, calls } = stub(() => json(fixture()));
    const { code, stdout, stderr } = await exec(['youtube', 'nope', '--handle', 'x'], { fetchImpl });
    expect(code).toBe(2);
    expect(calls).toHaveLength(1);
    expect(stdout).toBe('');
    // The line is JSON off a terminal, so the quotes around the command arrive escaped.
    expect(stderr).toMatch(/Unknown command \\?"youtube nope\\?"\. Run `truescrape list` to see what exists\./);
    const alone = await exec(['nothing'], { fetchImpl: stub(() => json(fixture())).fetchImpl });
    expect(alone.code).toBe(2);
    expect(alone.stderr).toMatch(/Unknown command \\?"nothing\\?"/);
  });

  it('treats a refresh that cannot be made as a typo, exit 2, saying the live catalogue was not checked', async () => {
    const { fetchImpl, calls } = stub(() => {
      throw new TypeError('fetch failed');
    });
    const { code, stdout, stderr } = await exec(['youtube', 'nope', '--handle', 'x'], { fetchImpl });
    expect(code).toBe(2);
    expect(calls).toHaveLength(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/live catalogue/i);
    expect(stderr).toMatch(/Unknown command \\?"youtube nope\\?"/);
    const down = await exec(['youtube', 'nope'], { fetchImpl: stub(() => new Response('<html>502</html>', { status: 502 })).fetchImpl });
    expect(down.code).toBe(2);
  });

  it('never fires for a known command', async () => {
    const { fetchImpl, calls } = stub(() => ok({ items: [1] }));
    await exec(['youtube', 'channel-videos', '--handle', 'x'], { fetchImpl });
    expect(calls.some((c) => c.url.endsWith('/openapi.json'))).toBe(false);
  });
});
