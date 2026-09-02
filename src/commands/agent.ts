import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Command } from 'commander';
import { requireKey, run, type Context, type ContextOverrides } from '../context.js';
import { UsageError, emit } from '../output.js';

export const TARGETS = ['claude-code', 'claude-desktop', 'cursor', 'vscode'] as const;
export type Target = (typeof TARGETS)[number];
/** Every target but claude-code, which is configured by running its own CLI rather than by writing a file. */
export type FileTarget = Exclude<Target, 'claude-code'>;

/** What `/.well-known/mcp` advertises. The endpoint and header name come from here, never from a constant. */
export interface Discovery {
  endpoint: string;
  authentication: { type: string; in: string; name: string };
}

type Env = Record<string, string | undefined>;

export interface AgentOverrides extends ContextOverrides {
  home?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  exec?: (cmd: string, args: string[]) => { status: number | null };
  which?: (cmd: string) => boolean;
}

interface AddOptions {
  project?: boolean;
  dryRun?: boolean;
}

const SERVER_NAME = 'truescrape';
const DISCOVERY_PATH = '/.well-known/mcp';

/** VS Code keys its servers differently from the other two. */
const TOP_KEY: Record<FileTarget, 'mcpServers' | 'servers'> = {
  'claude-desktop': 'mcpServers',
  cursor: 'mcpServers',
  vscode: 'servers',
};

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function configPathFor(target: FileTarget, opts: { home: string; platform: NodeJS.Platform; env: Env; cwd: string; project: boolean }): string {
  const { home, platform, env, cwd, project } = opts;
  switch (target) {
    case 'claude-desktop': {
      const file = 'claude_desktop_config.json';
      if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', file);
      if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', file);
      return join(home, '.config', 'Claude', file);
    }
    case 'cursor':
      return join(project ? cwd : home, '.cursor', 'mcp.json');
    case 'vscode':
      return join(cwd, '.vscode', 'mcp.json');
  }
}

export function entryFor(target: FileTarget, discovery: Discovery, key: string, platform: NodeJS.Platform): Record<string, unknown> {
  switch (target) {
    case 'claude-desktop':
      // Desktop cannot send a header to a remote server from its config, so it gets the stdio
      // bridge. On Windows npx is a .cmd shim, which only cmd can launch.
      return platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'npx', '-y', SERVER_NAME, 'mcp'], env: { TRUESCRAPE_API_KEY: key } }
        : { command: 'npx', args: ['-y', SERVER_NAME, 'mcp'], env: { TRUESCRAPE_API_KEY: key } };
    case 'cursor':
      return { url: discovery.endpoint, headers: { [discovery.authentication.name]: key } };
    case 'vscode':
      return { type: 'http', url: discovery.endpoint, headers: { [discovery.authentication.name]: key } };
  }
}

/**
 * Replaces only the truescrape entry. Everything else the client keeps in the
 * file is passed through untouched, and a file that cannot be parsed is never
 * overwritten: the user fixes it, we do not guess at it.
 */
export function mergeConfig(existingText: string | null, target: FileTarget, entry: Record<string, unknown>, label = 'The existing config'): string {
  const topKey = TOP_KEY[target];
  let root: Record<string, unknown> = {};

  if (existingText !== null && existingText.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch {
      throw new UsageError(`${label} is not valid JSON; fix it or move it aside, then rerun. Nothing was written.`);
    }
    if (!isRecord(parsed)) throw new UsageError(`${label} is not a JSON object; fix it or move it aside, then rerun. Nothing was written.`);
    root = parsed;
  }

  const servers = root[topKey] ?? {};
  if (!isRecord(servers)) throw new UsageError(`${label} has a "${topKey}" that is not an object; fix it, then rerun. Nothing was written.`);

  const next = { ...root, [topKey]: { ...servers, [SERVER_NAME]: entry } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

function quote(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

export function claudeCodeCommand(discovery: Discovery, key: string, project: boolean): { command: string; args: string[]; line: string } {
  const command = 'claude';
  const args = [
    'mcp',
    'add',
    '--transport',
    'http',
    SERVER_NAME,
    discovery.endpoint,
    '--header',
    `${discovery.authentication.name}: ${key}`,
    '--scope',
    project ? 'project' : 'user',
  ];
  return { command, args, line: [command, ...args.map(quote)].join(' ') };
}

/**
 * Discovery reports the endpoint as the server believes its public URL to be,
 * and a deployment can believe it is an internal origin. The path is the
 * server's to advertise; the origin is the one the user already reaches.
 */
export function rehost(endpoint: string, baseUrl: string): string {
  try {
    const advertised = new URL(endpoint);
    return `${new URL(baseUrl).origin}${advertised.pathname}${advertised.search}`;
  } catch {
    return endpoint;
  }
}

async function discover(ctx: Context): Promise<Discovery> {
  const url = `${ctx.client.baseUrl}${DISCOVERY_PATH}`;
  const refuse = (reason: string) => new UsageError(`Could not read ${url}; refusing to write a config from memory. (${reason})`);

  let response: Response;
  try {
    response = await ctx.client.raw('GET', DISCOVERY_PATH);
  } catch (err) {
    throw refuse(err instanceof Error ? err.message : String(err));
  }
  if (!response.ok) throw refuse(`HTTP ${response.status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw refuse('the body is not JSON');
  }

  const doc = body as { endpoint?: unknown; authentication?: { type?: unknown; in?: unknown; name?: unknown } };
  if (typeof doc?.endpoint !== 'string') throw refuse('no endpoint advertised');
  const auth = doc.authentication;
  if (!auth || auth.in !== 'header' || typeof auth.name !== 'string' || typeof auth.type !== 'string') {
    throw refuse('the advertised authentication is not a header');
  }
  return { endpoint: rehost(doc.endpoint, ctx.settings.baseUrl), authentication: { type: auth.type, in: 'header', name: auth.name } };
}

function readExisting(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new UsageError(`${path} is a symlink; refusing to write through it. Replace it with a regular file, then rerun.`);
  if (!stat.isFile()) throw new UsageError(`${path} exists and is not a regular file. Nothing was written.`);
  return readFileSync(path, 'utf8');
}

/** Temp file then rename, so a crash leaves the old file; owner-only because the key is inside. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function onPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .some((dir) => exts.some((ext) => existsSync(join(dir, cmd + ext))));
}

function spawn(cmd: string, args: string[]): { status: number | null } {
  // Windows installs claude as a .cmd shim, which Node will only launch through a shell,
  // and the shell does not quote arguments for us.
  const shell = process.platform === 'win32';
  const result = spawnSync(cmd, shell ? args.map(quote) : args, { stdio: 'inherit', shell });
  return { status: result.status };
}

async function add(ctx: Context, target: string, opts: AddOptions, overrides: AgentOverrides): Promise<void> {
  if (!isTarget(target)) throw new UsageError(`Unknown target "${target}". Use one of: ${TARGETS.join(', ')}.`);
  const key = requireKey(ctx);
  const project = Boolean(opts.project);
  const dryRun = Boolean(opts.dryRun);
  if (target === 'claude-desktop' && project) throw new UsageError('--project does not apply to claude-desktop; it keeps one config per user.');

  const platform = overrides.platform ?? process.platform;
  const home = overrides.home ?? homedir();
  const cwd = overrides.cwd ?? process.cwd();
  const discovery = await discover(ctx);

  if (target === 'claude-code') {
    const { command, args, line } = claudeCodeCommand(discovery, key, project);
    const which = overrides.which ?? onPath;
    if (dryRun || !which(command)) {
      ctx.streams.stdout(`${line}\n`);
      if (!dryRun && !ctx.output.quiet) ctx.streams.stderr(`${command} is not on PATH; run the command above once it is.\n`);
      return;
    }
    const { status } = (overrides.exec ?? spawn)(command, args);
    if (status !== 0) {
      ctx.streams.stderr(`${command} mcp add exited with status ${status ?? 'unknown'}.\n`);
      process.exitCode = status ?? 1;
      return;
    }
    emit({ data: { target, scope: project ? 'project' : 'user', ran: true }, status: 200 }, { ...ctx.output, quiet: true }, ctx.streams);
    return;
  }

  const path = configPathFor(target, { home, platform, env: ctx.env, cwd, project });
  const text = mergeConfig(readExisting(path), target, entryFor(target, discovery, key, platform), path);

  if (dryRun) {
    ctx.streams.stdout(text);
    if (!ctx.output.quiet) ctx.streams.stderr(`dry run: ${path} was not written.\n`);
    return;
  }

  writeAtomic(path, text);
  emit({ data: { target, path, written: true }, status: 200 }, { ...ctx.output, quiet: true }, ctx.streams);
}

export function register(program: Command, overrides: AgentOverrides = {}): void {
  const agent = program.command('agent').description('Connect an agent client to the TrueScrape MCP server');

  agent
    .command('add')
    .description(`Write the MCP config for a client. Targets: ${TARGETS.join(', ')}`)
    .argument('<target>', 'claude-code, claude-desktop (macOS and Windows; unofficial builds on Linux), cursor, or vscode')
    .option('--project', 'Project-level config in the current directory instead of the user-level one (cursor, claude-code)')
    .option('--dry-run', 'Print what would be written or run, and change nothing')
    .action(async (target: string, opts: AddOptions, command: Command) => {
      await run(command, (ctx) => add(ctx, target, opts, overrides), overrides);
    });
}
