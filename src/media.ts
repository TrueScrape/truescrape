import { open, rename, rm } from 'node:fs/promises';

/**
 * Saving a public video. The file address comes from a third-party payload,
 * so it is checked before use: https, no credentials or port, and a host on
 * the platform's own CDN list. Only the post lookup goes through the API; the
 * file comes straight from the platform.
 */

export type MediaPlatform = 'instagram' | 'facebook' | 'twitter';

export const MAX_MEDIA_BYTES = 150 * 1024 * 1024;

/** Instagram serves video from its own CDN and from Facebook's; X serves video only from `video.twimg.com`. */
const HOSTS: Record<MediaPlatform, readonly string[]> = {
  instagram: ['cdninstagram.com', 'fbcdn.net'],
  facebook: ['fbcdn.net'],
  twitter: ['video.twimg.com'],
};

/** A label boundary, so `evilfbcdn.net` and `fbcdn.net.evil.example` do not match. */
export const onHost = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

export function isAllowedMediaUrl(platform: MediaPlatform, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return HOSTS[platform].some((suffix) => onHost(host, suffix));
}

export type PickReason = 'no_video' | 'stream_only' | 'blocked_host' | 'ambiguous';
export type Pick = { ok: true; url: string } | { ok: false; reason: PickReason };

const pathOf = (raw: string) => {
  try {
    return new URL(raw).pathname;
  } catch {
    return raw.split('?')[0] ?? raw;
  }
};

/** `mediaUrls` has no per-item type: carousels mix images and video, and X lists photos first and the video last. */
export function pickVideoUrl(platform: MediaPlatform, post: { mediaUrls?: unknown }): Pick {
  const urls = (Array.isArray(post.mediaUrls) ? post.mediaUrls : []).filter((u): u is string => typeof u === 'string');
  // A Facebook page can carry related videos beside the one asked for, so several candidates is not an answer.
  if (platform === 'facebook' && urls.length > 1) return { ok: false, reason: 'ambiguous' };

  const files = urls.filter((u) => /\.(mp4|mov|webm|m4v)$/i.test(pathOf(u)));
  if (files.length === 0) {
    return { ok: false, reason: urls.some((u) => /\.m3u8$/i.test(pathOf(u))) ? 'stream_only' : 'no_video' };
  }
  const url = platform === 'twitter' ? files[files.length - 1]! : files[0]!;
  return isAllowedMediaUrl(platform, url) ? { ok: true, url } : { ok: false, reason: 'blocked_host' };
}

const NAME_PREFIX: Record<MediaPlatform, string> = { instagram: 'instagram', facebook: 'facebook', twitter: 'x' };

/** Built from the post id, never from a header or the address, so it cannot leave the folder. */
export function mediaFilename(platform: MediaPlatform, id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '') || 'video';
  return `${NAME_PREFIX[platform]}-${clean}.mp4`;
}

export type SaveFailure =
  | { ok: false; reason: 'blocked_host' | 'not_video' | 'too_large' | 'network' | 'timeout' }
  | { ok: false; reason: 'http_error'; status: number };
export type Saved = { ok: true; bytes: number; contentType: string } | SaveFailure;

/** Streams the file to `<path>.part` and renames it on success; any failure removes the partial file. */
export async function saveMedia(
  platform: MediaPlatform,
  url: string,
  path: string,
  options: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<Saved> {
  if (!isAllowedMediaUrl(platform, url)) return { ok: false, reason: 'blocked_host' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 120_000);
  const thrown = (): SaveFailure => ({ ok: false, reason: timedOut ? 'timeout' : 'network' });
  const part = `${path}.part`;

  try {
    let response: Response;
    try {
      // A redirect would leave the host list unchecked; X answers 403 to a foreign Referer.
      response = await fetchImpl(url, { redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
    } catch {
      return thrown();
    }

    if (!response.ok) return { ok: false, reason: 'http_error', status: response.status };
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!contentType.startsWith('video/')) return { ok: false, reason: 'not_video' };
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' };
    if (!response.body) return { ok: false, reason: 'network' };

    const reader = response.body.getReader();
    const file = await open(part, 'w');
    let received = 0;
    let failure: SaveFailure | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          failure = { ok: false, reason: 'too_large' };
          await reader.cancel().catch(() => {});
          break;
        }
        await file.write(value);
      }
    } catch {
      failure = thrown();
    } finally {
      await file.close();
    }
    if (failure) {
      await rm(part, { force: true });
      return failure;
    }
    await rename(part, path);
    return { ok: true, bytes: received, contentType };
  } finally {
    clearTimeout(timer);
  }
}

const NAMES: Record<MediaPlatform, string> = { instagram: 'Instagram', facebook: 'Facebook', twitter: 'X' };

/** One plain sentence per way a lookup or a download can fail. */
export function failureMessage(platform: MediaPlatform, failure: { reason: PickReason | SaveFailure['reason']; status?: number }): string {
  const name = NAMES[platform];
  switch (failure.reason) {
    case 'no_video':
      return 'This post has no video to save. Photo posts have nothing to download.';
    case 'stream_only':
      return `${name} only publishes this video as a stream, not a file, so there is no single file to save.`;
    case 'blocked_host':
      return 'No safe video address was found for this post, so nothing was downloaded.';
    case 'ambiguous':
      return 'This post has more than one possible video, and the CLI will not guess which one you meant. Try the direct link to the video.';
    case 'not_video':
      return `${name} sent something that is not a video file, so nothing was saved.`;
    case 'too_large':
      return 'This video is larger than 150 MB, which is more than the CLI will download.';
    case 'network':
      return `The file could not be downloaded from ${name}. Check your connection and try again.`;
    case 'timeout':
      return 'The download took too long and was stopped. Try again, or try a shorter video.';
    case 'http_error': {
      const status = failure.status ?? 0;
      if (status === 403) return `${name} refused the file, or its address has expired. Run the command again to get a fresh one.`;
      if (status === 404 || status === 410) return `The file is no longer on ${name}'s servers. The post may have been deleted.`;
      return `${name} answered with an error (${status}) when asked for the file. Try again in a minute.`;
    }
  }
}
