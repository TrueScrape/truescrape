import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { requireKey, run, type Context, type ContextOverrides } from '../context.js';
import { failureMessage, mediaFilename, onHost, pickVideoUrl, saveMedia, type MediaPlatform } from '../media.js';
import { EXIT, UsageError, errorLine, metaLine, paint } from '../output.js';

export const PERMISSION = 'Only download videos you made or have permission to use.';

const ROUTES: { hosts: string[]; platform: MediaPlatform; path: string }[] = [
  { hosts: ['instagram.com'], platform: 'instagram', path: '/v1/instagram/post' },
  { hosts: ['facebook.com', 'fb.watch'], platform: 'facebook', path: '/v1/facebook/post' },
  { hosts: ['x.com', 'twitter.com'], platform: 'twitter', path: '/v1/twitter/tweet' },
];

const UNSUPPORTED =
  'Only Instagram, Facebook and X videos can be downloaded. Pass a post URL on instagram.com, facebook.com, fb.watch, x.com or twitter.com.';
const YOUTUBE =
  'YouTube video files are not available: YouTube does not publish them as plain files. For the text and details of a video, use `truescrape youtube transcript --url <url>` or `truescrape youtube video --url <url>`.';

/** Decided from the URL alone, so a refusal sends nothing and costs nothing. */
export function route(raw: string): (typeof ROUTES)[number] {
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    throw new UsageError(UNSUPPORTED);
  }
  if (onHost(host, 'youtube.com') || onHost(host, 'youtu.be')) throw new UsageError(YOUTUBE);
  const found = ROUTES.find((r) => r.hosts.some((h) => onHost(host, h)));
  if (!found) throw new UsageError(UNSUPPORTED);
  return found;
}

/** A download failure is not an API error, so it is reported here in the same shape, with its own reason as the code. */
function fail(ctx: Context, code: string, message: string): void {
  ctx.streams.stderr(process.stderr.isTTY ? `${paint('Error:', ctx.output.color, 'red')} ${message}\n` : `${errorLine(code, message)}\n`);
  process.exitCode = EXIT.api;
}

export function register(program: Command, overrides: ContextOverrides = {}): void {
  program
    .command('download <post-url>')
    .description('Save the video from a public Instagram, Facebook or X post (1 credit for the lookup)')
    .option('--out <dir>', 'Folder to save into. Default: the current folder')
    .option('--force', 'Overwrite a file that already exists')
    .option('--json', 'Print { path, bytes, platform, postId, sourceHost } instead of the path')
    .action(async function (this: Command, postUrl: string, opts: { out?: string; force?: boolean; json?: boolean }) {
      await run(
        this,
        async (ctx) => {
          ctx.streams.stderr(`${PERMISSION}\n`);
          const { platform, path } = route(postUrl);
          requireKey(ctx);

          const envelope = await ctx.client.get<{ id?: unknown; mediaUrls?: unknown }>(path, { url: postUrl });
          if (!ctx.output.quiet) ctx.streams.stderr(`${paint(metaLine(envelope), ctx.output.color, 'dim')}\n`);
          const post = envelope.data ?? {};
          const pick = pickVideoUrl(platform, post);
          if (!pick.ok) return fail(ctx, pick.reason, failureMessage(platform, pick));

          const postId = typeof post.id === 'string' ? post.id : '';
          const dir = resolve(opts.out ?? '.');
          const file = join(dir, mediaFilename(platform, postId));
          if (existsSync(file) && !opts.force) return fail(ctx, 'file_exists', `${file} already exists. Pass --force to overwrite it.`);

          await mkdir(dir, { recursive: true });
          const saved = await saveMedia(platform, pick.url, file, { fetchImpl: overrides.fetchImpl });
          if (!saved.ok) return fail(ctx, saved.reason, failureMessage(platform, saved));

          const sourceHost = new URL(pick.url).hostname;
          if (opts.json) {
            ctx.streams.stdout(`${JSON.stringify({ path: file, bytes: saved.bytes, platform, postId, sourceHost })}\n`);
          } else {
            ctx.streams.stdout(`${file}\n`);
            if (!ctx.output.quiet) ctx.streams.stderr(`Saved ${(saved.bytes / 1024 / 1024).toFixed(1)} MB (${saved.contentType}) from ${sourceHost}\n`);
          }
        },
        overrides,
      );
    });
}
