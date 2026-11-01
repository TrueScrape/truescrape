import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Streams } from '../output.js';
import { buildProgram, defaultRegistrations } from '../program.js';
import { register } from './monitors.js';

type Call = { method: string; url: URL; body: unknown };

/** One canned answer; a second request is a test failure, not a hang. */
function api(status: number, payload: unknown) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: new URL(String(url)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (calls.length > 1) throw new Error(`unexpected request: ${String(url)}`);
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (data: unknown) => api(200, { success: true, data });
const refused = (status: number, code: string, message: string, details?: unknown) => api(status, { success: false, error: { code, message, details } });

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

async function exec(argv: string[], fetchImpl: typeof fetch, env: Record<string, string | undefined> = { TRUESCRAPE_API_KEY: 'k', TRUESCRAPE_BASE_URL: 'https://api.example' }) {
  const streams = capture();
  const configFile = join(mkdtempSync(join(tmpdir(), 'ts-monitors-')), 'config.json');
  const program = buildProgram([(p) => register(p, { env, configFile, streams, isTTY: false, fetchImpl })]);
  program.exitOverride();
  await program.parseAsync(['node', 'truescrape', ...argv]);
  return { code: process.exitCode ?? 0, out: streams.out.join(''), err: streams.err.join('') };
}

const usage = (err: string) => (JSON.parse(err) as { error: { code: string; message: string } }).error;

afterEach(() => {
  process.exitCode = undefined;
});

const item = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  url: 'https://www.reddit.com/r/x/comments/p1/',
  title: 'Acme broke again',
  text: 'Has anyone else seen this?',
  authorHandle: 'someone',
  publishedAt: '2026-10-30T10:00:00.000Z',
  platform: 'reddit',
  ...over,
});

const FOUND = {
  term: 'Acme',
  items: [item()],
  sources: [
    { platform: 'reddit', outcome: 'ok', checked: 25, matched: 1, credits: 1 },
    { platform: 'bluesky', outcome: 'empty', checked: 0, matched: 0, credits: 0 },
    { platform: 'youtube', outcome: 'failed', code: 'upstream_blocked', checked: 0, matched: 0, credits: 0 },
    { platform: 'threads', outcome: 'timeout', code: 'upstream_timeout', checked: 0, matched: 0, credits: 0 },
    { platform: 'tiktok', outcome: 'unpaid', code: 'insufficient_credits', checked: 0, matched: 0, credits: 0 },
  ],
  skipped: [{ platform: 'instagram', reason: 'The term has no usable hashtag for this platform.' }],
  creditsCharged: 1,
};

describe('mentions find', () => {
  it('asks GET /v1/mentions with the term and platforms', async () => {
    const { fetchImpl, calls } = ok(FOUND);
    await exec(['mentions', 'find', 'Acme Corp', '--platforms', 'reddit, Bluesky'], fetchImpl);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/v1/mentions');
    expect(calls[0]?.url.searchParams.get('term')).toBe('Acme Corp');
    expect(calls[0]?.url.searchParams.get('platforms')).toBe('reddit,bluesky');
  });

  it('sends no platforms when none were named, so the server picks its default', async () => {
    const { fetchImpl, calls } = ok(FOUND);
    await exec(['mentions', 'find', 'Acme'], fetchImpl);
    expect(calls[0]?.url.searchParams.has('platforms')).toBe(false);
  });

  it('prints each mention with its link, and tells every source outcome apart', async () => {
    const { fetchImpl } = ok(FOUND);
    const { code, out, err } = await exec(['mentions', 'find', 'Acme'], fetchImpl);
    expect(code).toBe(0);
    expect(out).toContain('https://www.reddit.com/r/x/comments/p1/');
    const line = (platform: string) => out.split('\n').find((l) => l.trimStart().startsWith(`${platform}:`)) ?? '';
    expect(line('reddit')).toContain('1 of 25');
    expect(line('bluesky')).toMatch(/nothing/);
    expect(line('youtube')).toMatch(/could not be checked.*upstream_blocked/);
    expect(line('threads')).toMatch(/ran out of time/);
    expect(line('tiktok')).toMatch(/refused for credit.*insufficient_credits/);
    expect(line('instagram')).toMatch(/skipped.*hashtag/);
    expect(err).toContain('1 credit charged');
  });

  it('never reads as "no mentions" when a source failed and nothing matched', async () => {
    const { fetchImpl } = ok({ ...FOUND, items: [], creditsCharged: 0, sources: [
      { platform: 'reddit', outcome: 'empty', checked: 0, matched: 0, credits: 0 },
      { platform: 'youtube', outcome: 'failed', code: 'upstream_blocked', checked: 0, matched: 0, credits: 0 },
    ] });
    const { out } = await exec(['mentions', 'find', 'Acme'], fetchImpl);
    expect(out.split('\n')[0]).toMatch(/1 source could not be checked/);
    expect(out.split('\n')[0]).not.toMatch(/^No mentions\.?$/);
  });

  it('says plainly when every source answered and none matched', async () => {
    const { fetchImpl } = ok({ ...FOUND, items: [], skipped: [], creditsCharged: 0, sources: [{ platform: 'reddit', outcome: 'empty', checked: 0, matched: 0, credits: 0 }] });
    const { out } = await exec(['mentions', 'find', 'Acme'], fetchImpl);
    expect(out.split('\n')[0]).toBe('No mentions in the sources checked.');
  });

  it('exits 1 with the API error when every source failed, and prints no list', async () => {
    const { fetchImpl } = refused(502, 'upstream_unavailable', 'No source answered, so this says nothing about whether the term is mentioned.', { sources: FOUND.sources });
    const { code, out, err } = await exec(['mentions', 'find', 'Acme'], fetchImpl);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(usage(err).code).toBe('upstream_unavailable');
  });

  it('prints the data as JSON under --json, with the billing line still on stderr', async () => {
    const { fetchImpl } = ok(FOUND);
    const { out, err } = await exec(['mentions', 'find', 'Acme', '--json'], fetchImpl);
    expect(JSON.parse(out)).toEqual(FOUND);
    expect(err).toContain('1 credit charged');
  });

  it('honours --quiet on the billing line', async () => {
    const { fetchImpl } = ok(FOUND);
    expect((await exec(['mentions', 'find', 'Acme', '--quiet'], fetchImpl)).err).toBe('');
  });

  it('keeps control characters in scraped text off the terminal', async () => {
    const { fetchImpl } = ok({ ...FOUND, items: [item({ title: 'hi\u001b[2Jthere\nnext line' })] });
    const { out } = await exec(['mentions', 'find', 'Acme'], fetchImpl);
    expect(out).not.toContain('\u001b');
    expect(out).toContain('hi [2Jthere next line');
  });

  it('needs a key before it spends anything', async () => {
    const { fetchImpl, calls } = ok(FOUND);
    const { code } = await exec(['mentions', 'find', 'Acme'], fetchImpl, { TRUESCRAPE_BASE_URL: 'https://api.example' });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });
});

const CREATED = {
  monitorId: 'mon_1',
  term: 'Acme',
  platforms: [],
  accounts: [{ platform: 'youtube', handle: '@acme', subscriptionId: 'sub_1' }],
  skipped: [],
  creditsPerCheck: 1,
  checksPerDay: 0,
  schedule: 'manual',
  maxSpendCredits: null,
  spendNote: 'No recurring charge.',
};

describe('monitors create', () => {
  it('sends the frozen body, with every flag under its wire name', async () => {
    const { fetchImpl, calls } = api(201, { success: true, data: CREATED });
    await exec([
      'monitors', 'create', 'Acme',
      '--platforms', 'Reddit,bluesky',
      '--accounts', 'youtube:@acme,mastodon:acme@mastodon.social',
      '--interval', '7200',
      '--webhook', 'https://hook.example/x',
      '--stop-at', '2026-12-01T00:00:00Z',
      '--max-credits', '50',
      '--agent', 'claude-code',
    ], fetchImpl);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/v1/monitors');
    expect(calls[0]?.body).toEqual({
      term: 'Acme',
      platforms: ['reddit', 'bluesky'],
      accounts: [{ platform: 'youtube', handle: '@acme' }, { platform: 'mastodon', handle: 'acme@mastodon.social' }],
      interval_seconds: 7200,
      webhook_url: 'https://hook.example/x',
      stop_at: '2026-12-01T00:00:00Z',
      max_credits: 50,
      agent: 'claude-code',
    });
  });

  it('sends only the term when nothing else was asked for', async () => {
    const { fetchImpl, calls } = api(201, { success: true, data: CREATED });
    await exec(['monitors', 'create', 'Acme'], fetchImpl);
    expect(calls[0]?.body).toEqual({ term: 'Acme' });
  });

  it('--manual asks for no schedule and --no-search for an empty platform list', async () => {
    const { fetchImpl, calls } = api(201, { success: true, data: CREATED });
    await exec(['monitors', 'create', 'Acme', '--manual', '--no-search', '--accounts', 'youtube:@acme'], fetchImpl);
    expect(calls[0]?.body).toEqual({ term: 'Acme', schedule: 'manual', platforms: [], accounts: [{ platform: 'youtube', handle: '@acme' }] });
  });

  it('reports what each check costs and that creating it charged nothing', async () => {
    const { fetchImpl } = api(201, { success: true, data: { ...CREATED, creditsPerCheck: 12 } });
    const { out, err } = await exec(['monitors', 'create', 'Acme'], fetchImpl);
    expect(out).toContain('mon_1');
    expect(out).toContain('12 credits');
    expect(out).toContain('No recurring charge.');
    expect(err).toContain('0 credits charged');
  });

  it.each([
    [['--platforms', 'reddit', '--no-search'], /--platforms.*--no-search/],
    [['--accounts', 'youtube'], /platform:handle/],
    [['--accounts', 'youtube:'], /platform:handle/],
    [['--interval', 'hourly'], /--interval/],
    [['--interval', '0'], /--interval/],
    [['--max-credits', '1.5'], /--max-credits/],
    [['--manual', '--interval', '3600'], /--manual.*--interval/],
  ])('refuses %j before sending anything', async (flags, message) => {
    const { fetchImpl, calls } = api(201, { success: true, data: CREATED });
    const { code, err } = await exec(['monitors', 'create', 'Acme', ...flags], fetchImpl);
    expect(code).toBe(2);
    expect(usage(err).message).toMatch(message);
    expect(calls).toEqual([]);
  });

  it('exits 1 on a refusal from the API, and passes its message on', async () => {
    const { fetchImpl } = refused(400, 'invalid_request', 'stop_at does not apply to a manual monitor.');
    const { code, out, err } = await exec(['monitors', 'create', 'Acme', '--manual', '--stop-at', '2026-12-01T00:00:00Z'], fetchImpl);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(usage(err).message).toContain('stop_at');
  });

  it('prints the data under --json', async () => {
    const { fetchImpl } = api(201, { success: true, data: CREATED });
    expect(JSON.parse((await exec(['monitors', 'create', 'Acme', '--json'], fetchImpl)).out)).toEqual(CREATED);
  });
});

const LISTED = [{
  monitorId: 'mon_1',
  term: 'Acme',
  intervalSeconds: 21600,
  lastCheckedAt: '2026-10-31T00:00:00.000Z',
  mentionsTotal: 4,
  creditsPerCheck: 3,
  checksPerDay: 4,
  creditsSpent: 9,
  schedule: 'timed',
  agent: 'claude-code',
  state: 'ended',
  endedReason: 'max_credits',
  sources: [{ platform: 'reddit', state: 'ended' }, { platform: 'youtube', state: 'paused_unpaid' }],
}];

describe('monitors list', () => {
  it('names the state, why it ended, the spend, the cost and the agent behind each', async () => {
    const { fetchImpl, calls } = ok(LISTED);
    const { code, out } = await exec(['monitors', 'list'], fetchImpl);
    expect(code).toBe(0);
    expect(calls[0]?.url.pathname).toBe('/v1/monitors');
    for (const text of ['mon_1', 'Acme', 'ended (max_credits)', '9 credits spent', '3 credits per check', 'claude-code', 'youtube: paused_unpaid']) expect(out).toContain(text);
  });

  it('says so when there are none', async () => {
    const { fetchImpl } = ok([]);
    expect((await exec(['monitors', 'list'], fetchImpl)).out).toBe('No monitors.\n');
  });

  it('prints the data under --json', async () => {
    const { fetchImpl } = ok(LISTED);
    expect(JSON.parse((await exec(['monitors', 'list', '--json'], fetchImpl)).out)).toEqual(LISTED);
  });

  it('exits 1 on an API error', async () => {
    const { fetchImpl } = refused(401, 'invalid_api_key', 'Bad key.');
    expect((await exec(['monitors', 'list'], fetchImpl)).code).toBe(1);
  });
});

describe('monitors delete', () => {
  it('sends DELETE on the encoded id', async () => {
    const { fetchImpl, calls } = ok({ deleted: true });
    const { code, out } = await exec(['monitors', 'delete', 'mon/1'], fetchImpl);
    expect(code).toBe(0);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/v1/monitors/mon%2F1');
    expect(out).toContain('mon/1');
  });

  it('exits 1 when the monitor does not exist', async () => {
    const { fetchImpl } = refused(404, 'not_found', 'No monitor with that id.');
    expect((await exec(['monitors', 'delete', 'mon_x'], fetchImpl)).code).toBe(1);
  });

  it('prints the data under --json', async () => {
    const { fetchImpl } = ok({ deleted: true });
    expect(JSON.parse((await exec(['monitors', 'delete', 'mon_1', '--json'], fetchImpl)).out)).toEqual({ deleted: true });
  });
});

const source = (over: Record<string, unknown> = {}) => ({
  platform: 'reddit',
  endpoint: 'reddit.search',
  outcome: 'ok',
  credits: 1,
  newCount: 1,
  lastCheckedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const CHECKED = {
  monitorId: 'mon_1',
  isBaseline: false,
  creditsCharged: 4,
  newItems: [item({ source: 'account', baseline: false })],
  sources: [source({ credits: 3 }), source({ platform: 'bluesky', endpoint: 'bluesky.userPosts', outcome: 'failed', code: 'upstream_blocked', credits: 0, newCount: 0, lastCheckedAt: null })],
  notes: ['youtube results carry no date.'],
};

describe('monitors check', () => {
  it('POSTs to the check route and reports new items, sources, notes and the credits charged', async () => {
    const { fetchImpl, calls } = ok(CHECKED);
    const { code, out, err } = await exec(['monitors', 'check', 'mon_1'], fetchImpl);
    expect(code).toBe(0);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/v1/monitors/mon_1/check');
    expect(out).toContain('1 new');
    expect(out).toContain('https://www.reddit.com/r/x/comments/p1/');
    expect(out).toMatch(/bluesky: could not be checked.*upstream_blocked/);
    expect(out).toContain('youtube results carry no date.');
    expect(err).toContain('4 credits charged');
  });

  it('says a first check is the baseline, not that nothing happened', async () => {
    const { fetchImpl } = ok({ ...CHECKED, isBaseline: true, newItems: [], sources: [source({ newCount: 0 })] });
    const { out } = await exec(['monitors', 'check', 'mon_1'], fetchImpl);
    expect(out.split('\n')[0]).toMatch(/baseline/i);
  });

  it('nothing new with a failed source does not read as nothing new', async () => {
    const { fetchImpl } = ok({ ...CHECKED, newItems: [], sources: [source({ newCount: 0 }), source({ platform: 'bluesky', outcome: 'timeout', credits: 0, newCount: 0 })] });
    const { out } = await exec(['monitors', 'check', 'mon_1'], fetchImpl);
    expect(out.split('\n')[0]).toMatch(/1 source could not be checked/);
  });

  it('exits 1 when no source answered, because that is no answer at all', async () => {
    const data = { ...CHECKED, creditsCharged: 0, newItems: [], notes: [], sources: [source({ outcome: 'failed', code: 'upstream_blocked', credits: 0, newCount: 0 })] };
    const { fetchImpl } = ok(data);
    const human = await exec(['monitors', 'check', 'mon_1'], fetchImpl);
    expect(human.code).toBe(1);
    expect(human.out.split('\n')[0]).toMatch(/No source answered/);
    process.exitCode = undefined;

    const asJson = await exec(['monitors', 'check', 'mon_1', '--json'], ok(data).fetchImpl);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out)).toEqual(data);
  });

  it('exits 1 on an API error', async () => {
    const { fetchImpl } = refused(404, 'not_found', 'No monitor with that id.');
    const { code, out } = await exec(['monitors', 'check', 'mon_x'], fetchImpl);
    expect(code).toBe(1);
    expect(out).toBe('');
  });

  it('prints the data under --json with the charge on stderr', async () => {
    const { fetchImpl } = ok(CHECKED);
    const { out, err } = await exec(['monitors', 'check', 'mon_1', '--json'], fetchImpl);
    expect(JSON.parse(out)).toEqual(CHECKED);
    expect(err).toContain('4 credits charged');
  });
});

describe('monitors updates filters', () => {
  const empty = { items: [], nextCursor: null };

  it('sends platform, source and an ISO since', async () => {
    const { fetchImpl, calls } = ok(empty);
    await exec(['monitors', 'updates', '--platform', 'reddit', '--source', 'account', '--since', '2026-11-01T00:00:00Z'], fetchImpl);
    const url = calls[0]!.url;
    expect(url.searchParams.get('platform')).toBe('reddit');
    expect(url.searchParams.get('source')).toBe('account');
    expect(url.searchParams.get('since')).toBe('2026-11-01T00:00:00.000Z');
  });

  it('turns a window such as 7d into a time', async () => {
    const { fetchImpl, calls } = ok(empty);
    const before = Date.now();
    await exec(['monitors', 'updates', '--since', '7d'], fetchImpl);
    const since = Date.parse(calls[0]!.url.searchParams.get('since')!);
    expect(before - since).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(before - since).toBeLessThan(7 * 86_400_000 + 5000);
  });

  it('refuses a since it cannot read and a source it does not know, before any request', async () => {
    const a = ok(empty);
    expect((await exec(['monitors', 'updates', '--since', 'yesterday'], a.fetchImpl)).code).not.toBe(0);
    expect(a.calls).toEqual([]);
    const b = ok(empty);
    expect((await exec(['monitors', 'updates', '--source', 'everything'], b.fetchImpl)).code).not.toBe(0);
    expect(b.calls).toEqual([]);
  });

  it('a filtered --unread pages by cursor: it moved nothing, so running again would repeat it', async () => {
    const { fetchImpl } = ok({ items: [], nextCursor: 'abc' });
    expect((await exec(['monitors', 'updates', '--unread', '--platform', 'reddit'], fetchImpl)).out).toContain('--cursor abc');
  });
});

describe('monitors updates', () => {
  const PAGE = {
    items: [
      item({ monitorId: 'mon_1', term: 'Acme', source: 'account', baseline: false }),
      item({ id: 'p2', url: 'https://bsky.app/profile/a/post/2', platform: 'bluesky', title: null, text: 'Acme is fine', source: 'mention', baseline: true }),
    ],
    nextCursor: null,
  };

  it('maps its flags to the wire names', async () => {
    const { fetchImpl, calls } = ok(PAGE);
    await exec(['monitors', 'updates', '--monitor', 'mon_1', '--unread', '--query', 'broke', '--cursor', 'c1'], fetchImpl);
    expect(calls[0]?.url.pathname).toBe('/v1/monitors/mentions');
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ monitor: 'mon_1', unread_only: 'true', query: 'broke', cursor: 'c1' });
  });

  it('sends no filters when none were asked for', async () => {
    const { fetchImpl, calls } = ok(PAGE);
    await exec(['monitors', 'updates'], fetchImpl);
    expect(calls[0]?.url.search).toBe('');
  });

  it('labels each item by platform, by how it was found, and whether it predates the monitor', async () => {
    const { fetchImpl } = ok(PAGE);
    const { out, err } = await exec(['monitors', 'updates'], fetchImpl);
    expect(out).toContain('reddit, account');
    expect(out).toContain('bluesky, mention, baseline');
    expect(out).toContain('https://bsky.app/profile/a/post/2');
    expect(err).toContain('0 credits charged');
  });

  it('says there is more rather than letting a page read as the whole feed', async () => {
    const more = { ...PAGE, nextCursor: 'abc' };
    expect((await exec(['monitors', 'updates'], ok(more).fetchImpl)).out).toContain('--cursor abc');
    expect((await exec(['monitors', 'updates', '--unread'], ok(more).fetchImpl)).out).toMatch(/run this again/i);
  });

  it('says when there is nothing unread', async () => {
    const { fetchImpl } = ok({ items: [], nextCursor: null });
    expect((await exec(['monitors', 'updates', '--unread'], fetchImpl)).out).toBe('Nothing unread.\n');
  });

  it('exits 1 on an API error', async () => {
    const { fetchImpl } = refused(400, 'invalid_request', 'This team is zero-retention.');
    expect((await exec(['monitors', 'updates'], fetchImpl)).code).toBe(1);
  });

  it('prints the data under --json', async () => {
    const { fetchImpl } = ok(PAGE);
    expect(JSON.parse((await exec(['monitors', 'updates', '--json'], fetchImpl)).out)).toEqual(PAGE);
  });
});

describe('the real program', () => {
  it('registers both commands, with no catalogue platform shadowing them', () => {
    const names = buildProgram(defaultRegistrations).commands.map((c) => c.name());
    expect(names.filter((n) => n === 'mentions')).toHaveLength(1);
    expect(names.filter((n) => n === 'monitors')).toHaveLength(1);
  });
});
