import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_MEDIA_BYTES, isAllowedMediaUrl, mediaFilename, pickVideoUrl, saveMedia } from './media.js';

const IG_MP4 = 'https://scontent-nrt1-2.cdninstagram.com/v/t50.2886-16/clip.mp4?oe=abc&oh=def';
const FB_MP4 = 'https://video-lhr8-1.xx.fbcdn.net/o1/v/t2/f2/clip.mp4?oe=abc';
const X_MP4 = 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/clip.mp4?tag=14';

describe('isAllowedMediaUrl', () => {
  it.each([
    ['instagram', IG_MP4],
    ['instagram', FB_MP4],
    ['facebook', FB_MP4],
    ['twitter', X_MP4],
  ] as const)('%s accepts %s', (platform, url) => {
    expect(isAllowedMediaUrl(platform, url)).toBe(true);
  });

  it.each([
    ['instagram', 'http://scontent.cdninstagram.com/x.mp4'],
    ['instagram', 'https://cdninstagram.com.evil.example/x.mp4'],
    ['instagram', 'https://evilcdninstagram.com/x.mp4'],
    ['instagram', 'https://scontent.cdninstagram.com@evil.example/x.mp4'],
    ['instagram', 'https://user:pass@scontent.cdninstagram.com/x.mp4'],
    ['instagram', 'https://scontent.cdninstagram.com:8443/x.mp4'],
    ['instagram', 'https://example.com/x.mp4'],
    ['facebook', IG_MP4],
    ['facebook', 'https://evilfbcdn.net/x.mp4'],
    ['facebook', 'https://fbcdn.net.evil.example/x.mp4'],
    ['twitter', 'https://pbs.twimg.com/media/x.jpg'],
    ['twitter', 'https://video.twimg.com.evil.example/x.mp4'],
    ['twitter', 'javascript:alert(1)'],
    ['twitter', 'not a url'],
  ] as const)('%s refuses %s', (platform, url) => {
    expect(isAllowedMediaUrl(platform, url)).toBe(false);
  });
});

describe('pickVideoUrl', () => {
  it('takes the first video file on Instagram, skipping images', () => {
    const photo = 'https://scontent.cdninstagram.com/v/pic.jpg';
    expect(pickVideoUrl('instagram', { mediaUrls: [photo, IG_MP4] })).toEqual({ ok: true, url: IG_MP4 });
  });

  it('takes the last video file on X, where photos come first', () => {
    const photo = 'https://pbs.twimg.com/media/a.jpg';
    expect(pickVideoUrl('twitter', { mediaUrls: [photo, X_MP4] })).toEqual({ ok: true, url: X_MP4 });
  });

  it('reports no_video for a photo post or no media', () => {
    expect(pickVideoUrl('instagram', { mediaUrls: ['https://scontent.cdninstagram.com/v/pic.jpg'] })).toEqual({ ok: false, reason: 'no_video' });
    expect(pickVideoUrl('instagram', { mediaUrls: [] })).toEqual({ ok: false, reason: 'no_video' });
    expect(pickVideoUrl('instagram', {})).toEqual({ ok: false, reason: 'no_video' });
  });

  it('reports stream_only when there is only a playlist', () => {
    const hls = 'https://video.twimg.com/amplify_video/1/pl/abc.m3u8?tag=14';
    expect(pickVideoUrl('twitter', { mediaUrls: [hls] })).toEqual({ ok: false, reason: 'stream_only' });
  });

  it('reports blocked_host for a file on a host the platform does not use', () => {
    expect(pickVideoUrl('instagram', { mediaUrls: ['https://evil.example/clip.mp4'] })).toEqual({ ok: false, reason: 'blocked_host' });
  });

  it('reports ambiguous for a Facebook post with more than one candidate', () => {
    expect(pickVideoUrl('facebook', { mediaUrls: [FB_MP4, FB_MP4.replace('clip', 'other')] })).toEqual({ ok: false, reason: 'ambiguous' });
    expect(pickVideoUrl('facebook', { mediaUrls: [FB_MP4] })).toEqual({ ok: true, url: FB_MP4 });
  });
});

describe('mediaFilename', () => {
  it('is built from the post id', () => {
    expect(mediaFilename('instagram', 'CIWJ56ujr5w')).toBe('instagram-CIWJ56ujr5w.mp4');
    expect(mediaFilename('twitter', '2113776971603689874')).toBe('x-2113776971603689874.mp4');
  });

  it('strips anything that could leave the folder or change the type', () => {
    expect(mediaFilename('facebook', '../../etc/passwd')).toBe('facebook-etcpasswd.mp4');
    expect(mediaFilename('facebook', 'a b\\c.exe')).toBe('facebook-abcexe.mp4');
    expect(mediaFilename('facebook', '')).toBe('facebook-video.mp4');
  });
});

const video = (body: ConstructorParameters<typeof Response>[0], init: ResponseInit & { headers?: Record<string, string> } = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' }, ...init });

const tmpFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-media-'));
  return { dir, path: join(dir, 'clip.mp4') };
};

describe('saveMedia', () => {
  const bytes = new Uint8Array(1024).fill(7);

  it('streams the file to disk and leaves no .part behind', async () => {
    const { dir, path } = tmpFile();
    const fetchImpl = vi.fn(async () => video(bytes));
    expect(await saveMedia('instagram', IG_MP4, path, { fetchImpl })).toEqual({ ok: true, bytes: 1024, contentType: 'video/mp4' });
    expect(readFileSync(path).length).toBe(1024);
    expect(readdirSync(dir)).toEqual(['clip.mp4']);
  });

  it('refuses redirects and sends no referrer', async () => {
    const { path } = tmpFile();
    const fetchImpl = vi.fn(async () => video(bytes));
    await saveMedia('twitter', X_MP4, path, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe('error');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.signal).toBeDefined();
  });

  it('treats a redirect response as a failure, never following it', async () => {
    const { dir, path } = tmpFile();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.mp4' } }));
    expect(await saveMedia('instagram', IG_MP4, path, { fetchImpl })).toEqual({ ok: false, reason: 'http_error', status: 302 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    'https://evilfbcdn.net/x.mp4',
    'https://fbcdn.net.evil.example/x.mp4',
    'http://video.xx.fbcdn.net/x.mp4',
    'https://video.xx.fbcdn.net:444/x.mp4',
    'https://a:b@video.xx.fbcdn.net/x.mp4',
  ])('refuses %s before any fetch', async (url) => {
    const { path } = tmpFile();
    const fetchImpl = vi.fn(async () => video(bytes));
    expect(await saveMedia('facebook', url, path, { fetchImpl })).toEqual({ ok: false, reason: 'blocked_host' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-video content type and writes nothing', async () => {
    const { dir, path } = tmpFile();
    const fetchImpl = vi.fn(async () => video('<html>', { headers: { 'content-type': 'text/html' } }));
    expect(await saveMedia('instagram', IG_MP4, path, { fetchImpl })).toEqual({ ok: false, reason: 'not_video' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a declared size over the cap without reading it', async () => {
    const { path } = tmpFile();
    const fetchImpl = vi.fn(async () => video(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_MEDIA_BYTES + 1) } }));
    expect(await saveMedia('instagram', IG_MP4, path, { fetchImpl })).toEqual({ ok: false, reason: 'too_large' });
  });

  it('cuts off a stream that outgrows the cap and leaves no file behind', async () => {
    const { dir, path } = tmpFile();
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = vi.fn(async () => video(stream));
    expect(await saveMedia('instagram', IG_MP4, path, { fetchImpl, maxBytes: 256 * 1024 })).toEqual({ ok: false, reason: 'too_large' });
    expect(sent).toBeLessThan(1024 * 1024);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports an HTTP failure with its status', async () => {
    const { path } = tmpFile();
    const fetchImpl = vi.fn(async () => video('nope', { status: 403, headers: { 'content-type': 'text/plain' } }));
    expect(await saveMedia('instagram', IG_MP4, path, { fetchImpl })).toEqual({ ok: false, reason: 'http_error', status: 403 });
  });

  it('reports a thrown fetch as a network failure', async () => {
    const { path } = tmpFile();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await saveMedia('instagram', IG_MP4, path, { fetchImpl })).toEqual({ ok: false, reason: 'network' });
  });

  it('reports a timeout', async () => {
    const { path } = tmpFile();
    const fetchImpl = vi.fn(
      (_: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    expect(await saveMedia('instagram', IG_MP4, path, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5 })).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });
});
