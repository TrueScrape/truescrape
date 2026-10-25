import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextOverrides } from '../context.js';
import { type Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { register } from './download.js';

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

const IG_MP4 = 'https://scontent.cdninstagram.com/v/clip.mp4?oe=1';
const X_MP4 = 'https://video.twimg.com/amplify_video/1/vid/clip.mp4?tag=14';
const FB_MP4 = 'https://video.xx.fbcdn.net/v/clip.mp4?oe=1';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const video = (bytes = 2048) => new Response(new Uint8Array(bytes).fill(1), { status: 200, headers: { 'content-type': 'video/mp4' } });

/** The API answers with `post`; any other host answers with `file`. */
function stub(post: Record<string, unknown>, file: () => Response = () => video()) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return String(url).startsWith('https://api.truescrape.com/') ? json({ success: true, data: post, meta: { creditsCharged: 1 } }) : file();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function exitOverrideAll(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) exitOverrideAll(sub);
}

async function cli(argv: string[], overrides: ContextOverrides): Promise<void> {
  const program = buildProgram([(p) => register(p, overrides)]);
  exitOverrideAll(program);
  await program.parseAsync(['node', 'truescrape', ...argv]);
}

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-dl-'));
  return { dir, configFile: join(dir, 'config.json'), env: { TRUESCRAPE_API_KEY: 'k' }, streams: capture(), isTTY: false };
};

afterEach(() => {
  process.exitCode = undefined;
});

describe('download', () => {
  it.each([
    ['https://example.com/video/1', /instagram\.com.*facebook\.com.*x\.com/],
    ['https://notinstagram.com/reel/ABC/', /instagram\.com/],
    ['https://instagram.com.evil.example/reel/ABC/', /instagram\.com/],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', /youtube transcript/],
    ['https://youtu.be/dQw4w9WgXcQ', /youtube transcript/],
    ['not a url', /instagram\.com/],
  ])('refuses %s without any request', async (url, message) => {
    const { dir, configFile, env, streams, isTTY } = setup();
    const { fetchImpl, calls } = stub({ id: 'x', mediaUrls: [IG_MP4] });

    await cli(['download', url, '--out', dir], { env, configFile, streams, fetchImpl, isTTY });

    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(2);
    expect(streams.err.join('')).toMatch(message);
  });

  it('looks the post up once, saves the file under the post id and prints its path', async () => {
    const { dir, configFile, env, streams, isTTY } = setup();
    const { fetchImpl, calls } = stub({ id: 'C1a-B2', mediaUrls: ['https://scontent.cdninstagram.com/v/pic.jpg', IG_MP4] });

    await cli(['download', 'https://www.instagram.com/reel/C1a-B2/', '--out', dir], { env, configFile, streams, fetchImpl, isTTY });

    const path = join(dir, 'instagram-C1a-B2.mp4');
    expect(process.exitCode).toBeUndefined();
    expect(calls).toEqual([`https://api.truescrape.com/v1/instagram/post?url=${encodeURIComponent('https://www.instagram.com/reel/C1a-B2/')}`, IG_MP4]);
    expect(readFileSync(path).length).toBe(2048);
    expect(streams.out.join('')).toBe(`${path}\n`);
    expect(streams.err.join('')).toContain('Only download videos you made or have permission to use.');
  });

  it.each([
    ['https://x.com/nasa/status/123', '/v1/twitter/tweet', X_MP4, 'x-123.mp4'],
    ['https://twitter.com/nasa/status/123', '/v1/twitter/tweet', X_MP4, 'x-123.mp4'],
    ['https://fb.watch/abc/', '/v1/facebook/post', FB_MP4, 'facebook-123.mp4'],
    ['https://m.facebook.com/watch/?v=123', '/v1/facebook/post', FB_MP4, 'facebook-123.mp4'],
  ])('routes %s to %s', async (url, path, file, name) => {
    const { dir, configFile, env, streams, isTTY } = setup();
    const { fetchImpl, calls } = stub({ id: '123', mediaUrls: [file] });

    await cli(['download', url, '--out', dir], { env, configFile, streams, fetchImpl, isTTY });

    expect(calls[0]).toContain(`https://api.truescrape.com${path}?url=`);
    expect(existsSync(join(dir, name))).toBe(true);
  });

  it('prints the result as JSON under --json', async () => {
    const { dir, configFile, env, streams, isTTY } = setup();
    const { fetchImpl } = stub({ id: '123', mediaUrls: [X_MP4] });

    await cli(['download', 'https://x.com/nasa/status/123', '--out', dir, '--json'], { env, configFile, streams, fetchImpl, isTTY });

    expect(JSON.parse(streams.out.join(''))).toEqual({
      path: join(dir, 'x-123.mp4'),
      bytes: 2048,
      platform: 'twitter',
      postId: '123',
      sourceHost: 'video.twimg.com',
    });
  });

  it('will not overwrite an existing file without --force', async () => {
    const { dir, configFile, env, streams, isTTY } = setup();
    const path = join(dir, 'x-123.mp4');
    writeFileSync(path, 'mine');
    const first = stub({ id: '123', mediaUrls: [X_MP4] });

    await cli(['download', 'https://x.com/nasa/status/123', '--out', dir], { env, configFile, streams, fetchImpl: first.fetchImpl, isTTY });

    expect(process.exitCode).toBe(1);
    expect(first.calls).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe('mine');
    expect(streams.err.join('')).toContain('--force');

    process.exitCode = undefined;
    const second = stub({ id: '123', mediaUrls: [X_MP4] });
    await cli(['download', 'https://x.com/nasa/status/123', '--out', dir, '--force'], { env, configFile, streams: capture(), fetchImpl: second.fetchImpl, isTTY });
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(path).length).toBe(2048);
  });

  it('exits 1 with one plain sentence when the post has no video', async () => {
    const { dir, configFile, env, streams, isTTY } = setup();
    const { fetchImpl, calls } = stub({ id: '123', mediaUrls: ['https://scontent.cdninstagram.com/v/pic.jpg'] });

    await cli(['download', 'https://www.instagram.com/p/123/', '--out', dir], { env, configFile, streams, fetchImpl, isTTY });

    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    expect(streams.out).toEqual([]);
    expect(streams.err.join('')).toContain('This post has no video to save.');
  });

  it('exits 1 when the file is not a video, and saves nothing', async () => {
    const { dir, configFile, env, streams, isTTY } = setup();
    const { fetchImpl } = stub({ id: '123', mediaUrls: [X_MP4] }, () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));

    await cli(['download', 'https://x.com/nasa/status/123', '--out', dir], { env, configFile, streams, fetchImpl, isTTY });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(dir, 'x-123.mp4'))).toBe(false);
    expect(streams.err.join('')).toContain('not a video file');
  });
});
