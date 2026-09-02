import { describe, expect, it, vi } from 'vitest';
import { ApiError, Client, NetworkError, USER_AGENT, buildQuery } from './client.js';

type Call = { url: string; init: RequestInit };

function stub(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('query building', () => {
  it('skips undefined and stringifies booleans and numbers', () => {
    expect(buildQuery({ handle: '@mkbhd', tab: undefined, include_raw: true, limit: 5 })).toBe('?handle=%40mkbhd&include_raw=true&limit=5');
    expect(buildQuery({})).toBe('');
  });
});

describe('Client', () => {
  it('sends the key, the accept header and a user agent', async () => {
    const { fetchImpl, calls } = stub(() => json({ success: true, data: { ok: 1 }, meta: { creditsCharged: 1 } }));
    const client = new Client({ baseUrl: 'https://api.example/', apiKey: 'k', fetchImpl });
    const result = await client.get<{ ok: number }>('/v1/youtube/channel', { handle: '@x' });

    expect(calls[0]?.url).toBe('https://api.example/v1/youtube/channel?handle=%40x');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    expect(headers['user-agent']).toBe(USER_AGENT);
    expect(headers.accept).toBe('application/json');
    expect(result).toMatchObject({ data: { ok: 1 }, meta: { creditsCharged: 1 }, status: 200 });
  });

  it('omits the key header when there is none', async () => {
    const { fetchImpl, calls } = stub(() => json({ success: true, data: null }));
    await new Client({ baseUrl: 'https://api.example', fetchImpl }).get('/health');
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('keeps the API error code from a 401 envelope and never invents one', async () => {
    const { fetchImpl } = stub(() =>
      json({ success: false, error: { code: 'invalid_api_key', message: 'Unrecognised key.' } }, 401, { 'x-request-id': 'req_1' }),
    );
    const client = new Client({ baseUrl: 'https://api.example', apiKey: 'bad', fetchImpl });
    const err = await client.get('/v1/account/credit-balance').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'invalid_api_key', status: 401, message: 'Unrecognised key.', requestId: 'req_1' });
  });

  it('keeps 402 distinct from 401', async () => {
    const { fetchImpl } = stub(() => json({ success: false, error: { code: 'insufficient_credits', message: 'Top up.' } }, 402));
    const err = await new Client({ baseUrl: 'https://api.example', apiKey: 'k', fetchImpl }).get('/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'insufficient_credits', status: 402 });
  });

  it('reports a non-JSON body as upstream_unavailable with the status', async () => {
    const { fetchImpl } = stub(() => new Response('<html>502</html>', { status: 502 }));
    const err = await new Client({ baseUrl: 'https://api.example', fetchImpl }).get('/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream_unavailable', status: 502 });
  });

  it('wraps a failed connection as NetworkError naming the URL', async () => {
    const { fetchImpl } = stub(() => {
      throw new TypeError('fetch failed');
    });
    const err = await new Client({ baseUrl: 'https://down.example', fetchImpl }).get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toContain('https://down.example/x');
  });

  it('posts JSON and passes the pagination block through', async () => {
    const { fetchImpl, calls } = stub(() => json({ success: true, data: { jobId: 'job_1' }, pagination: { cursor: 'c', hasMore: true, count: 1 } }, 202));
    const result = await new Client({ baseUrl: 'https://api.example', apiKey: 'k', fetchImpl }).post('/v1/jobs/batch', { a: 1 });
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect(result).toMatchObject({ status: 202, pagination: { cursor: 'c', hasMore: true } });
  });

  it('calls onRequest with timing for --verbose', async () => {
    const onRequest = vi.fn();
    const { fetchImpl } = stub(() => json({ success: true, data: 1 }));
    await new Client({ baseUrl: 'https://api.example', fetchImpl, onRequest }).get('/x');
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: 'https://api.example/x', status: 200 }));
  });
});
