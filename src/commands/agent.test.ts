import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageError, type Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { claudeCodeCommand, configPathFor, entryFor, mergeConfig, register, rehost, type Discovery } from './agent.js';

const KEY = 'sk-test-key';
const BASE = 'https://api.example.test';

// Deliberately not the production values, so a hardcoded URL or header name fails these tests.
// The endpoint sits on an internal origin, the way a deployment sees itself from inside.
const DISCOVERY = {
  mcpVersion: '2025-03-26',
  endpoint: 'http://localhost:3000/rpc',
  transport: 'http',
  authentication: { type: 'apiKey', in: 'header', name: 'x-agent-key' },
  tools: 3,
};
/** What must be written: the advertised path on the base URL's origin. */
const ENDPOINT = `${BASE}/rpc`;
const discovery: Discovery = { endpoint: ENDPOINT, authentication: DISCOVERY.authentication };
const tmp =(label: string) => mkdtempSync(join(tmpdir(), `ts-agent-${label}-`));

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

function fetchStub(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

const unreachable: typeof fetch = async () => {
  throw new TypeError('fetch failed');
};

interface InvokeOptions {
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  which?: (cmd: string) => boolean;
  exec?: (cmd: string, args: string[]) => { status: number | null };
  home?: string;
  cwd?: string;
}

async function invoke(argv: string[], opts: InvokeOptions = {}) {
  const home = opts.home ?? tmp('home');
  const cwd = opts.cwd ?? tmp('cwd');
  const streams = capture();
  const exec = opts.exec ?? vi.fn(() => ({ status: 0 }));
  const which = opts.which ?? (() => false);
  const program = buildProgram([
    (p) =>
      register(p, {
        env: { TRUESCRAPE_API_KEY: KEY, TRUESCRAPE_BASE_URL: BASE, ...opts.env },
        configFile: join(home, 'unused-config.json'),
        streams,
        isTTY: false,
        fetchImpl: opts.fetchImpl ?? fetchStub(DISCOVERY),
        home,
        cwd,
        platform: opts.platform ?? 'linux',
        exec,
        which,
      }),
  ]);
  program.exitOverride();
  await program.parseAsync(['node', 'truescrape', 'agent', 'add', ...argv]);
  return { code: process.exitCode ?? 0, home, cwd, streams, exec };
}

const stdoutJson = (streams: { out: string[] }) => JSON.parse(streams.out.join('')) as Record<string, unknown>;
const usageMessage = (streams: { err: string[] }) => (JSON.parse(streams.err.join('')) as { error: { message: string } }).error.message;

const canSymlink = (() => {
  try {
    const dir = tmp('symlink-probe');
    writeFileSync(join(dir, 'a'), '');
    symlinkSync(join(dir, 'a'), join(dir, 'b'), 'file');
    return true;
  } catch {
    return false;
  }
})();

afterEach(() => {
  process.exitCode = undefined;
});

describe('configPathFor', () => {
  const base = { home: '/home/u', env: {}, cwd: '/work', project: false };

  it('puts the Claude Desktop file where each OS keeps it', () => {
    expect(configPathFor('claude-desktop', { ...base, platform: 'darwin' })).toBe(join('/home/u', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    expect(configPathFor('claude-desktop', { ...base, platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } })).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(configPathFor('claude-desktop', { ...base, platform: 'linux' })).toBe(join('/home/u', '.config', 'Claude', 'claude_desktop_config.json'));
  });

  it('puts Cursor under home, or under cwd with --project', () => {
    expect(configPathFor('cursor', { ...base, platform: 'linux' })).toBe(join('/home/u', '.cursor', 'mcp.json'));
    expect(configPathFor('cursor', { ...base, platform: 'linux', project: true })).toBe(join('/work', '.cursor', 'mcp.json'));
  });

  it('puts VS Code under cwd only', () => {
    expect(configPathFor('vscode', { ...base, platform: 'linux' })).toBe(join('/work', '.vscode', 'mcp.json'));
    expect(configPathFor('vscode', { ...base, platform: 'linux', project: true })).toBe(join('/work', '.vscode', 'mcp.json'));
  });
});

describe('entryFor', () => {
  it('gives Claude Desktop the stdio bridge, via cmd on Windows', () => {
    expect(entryFor('claude-desktop', discovery, KEY, 'darwin')).toEqual({ command: 'npx', args: ['-y', 'truescrape', 'mcp'], env: { TRUESCRAPE_API_KEY: KEY } });
    expect(entryFor('claude-desktop', discovery, KEY, 'linux')).toEqual({ command: 'npx', args: ['-y', 'truescrape', 'mcp'], env: { TRUESCRAPE_API_KEY: KEY } });
    expect(entryFor('claude-desktop', discovery, KEY, 'win32')).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', 'truescrape', 'mcp'], env: { TRUESCRAPE_API_KEY: KEY } });
  });

  it('gives Cursor and VS Code the advertised endpoint and header', () => {
    expect(entryFor('cursor', discovery, KEY, 'linux')).toEqual({ url: ENDPOINT, headers: { 'x-agent-key': KEY } });
    expect(entryFor('vscode', discovery, KEY, 'linux')).toEqual({ type: 'http', url: ENDPOINT, headers: { 'x-agent-key': KEY } });
  });
});

describe('mergeConfig', () => {
  const entry = { url: 'https://x', headers: { h: 'k' } };

  it('creates the document when there is no file', () => {
    expect(JSON.parse(mergeConfig(null, 'cursor', entry))).toEqual({ mcpServers: { truescrape: entry } });
    expect(JSON.parse(mergeConfig(null, 'vscode', entry))).toEqual({ servers: { truescrape: entry } });
  });

  it('touches only the truescrape entry and keeps foreign servers and other keys intact', () => {
    const existing = {
      theme: 'dark',
      mcpServers: {
        alpha: { command: 'alpha', args: ['--one'], env: { A: '1' } },
        truescrape: { url: 'https://stale', headers: { old: 'value' } },
        beta: { url: 'https://beta.example.test', headers: { authorization: 'Bearer b' } },
      },
      nested: { keep: [1, 2, { three: 3 }] },
    };
    const merged = JSON.parse(mergeConfig(JSON.stringify(existing), 'cursor', entry)) as typeof existing;
    expect(merged.mcpServers.truescrape).toEqual(entry);
    expect(merged.mcpServers.alpha).toEqual(existing.mcpServers.alpha);
    expect(merged.mcpServers.beta).toEqual(existing.mcpServers.beta);
    expect(merged.theme).toEqual(existing.theme);
    expect(merged.nested).toEqual(existing.nested);
    expect(Object.keys(merged)).toEqual(Object.keys(existing));
    expect(Object.keys(merged.mcpServers)).toEqual(Object.keys(existing.mcpServers));
  });

  it('refuses to overwrite a file it cannot parse', () => {
    expect(() => mergeConfig('{not json', 'cursor', entry)).toThrow(UsageError);
    expect(() => mergeConfig('[]', 'cursor', entry)).toThrow(UsageError);
  });
});

describe('claudeCodeCommand', () => {
  it('spells out the exact command for user and project scope', () => {
    const user = claudeCodeCommand(discovery, KEY, false);
    expect(user.command).toBe('claude');
    expect(user.args).toEqual(['mcp', 'add', '--transport', 'http', 'truescrape', ENDPOINT, '--header', `x-agent-key: ${KEY}`, '--scope', 'user']);
    expect(user.line).toBe(`claude mcp add --transport http truescrape ${ENDPOINT} --header "x-agent-key: ${KEY}" --scope user`);
    expect(claudeCodeCommand(discovery, KEY, true).line).toMatch(/--scope project$/);
  });
});

describe('rehost', () => {
  it('keeps the advertised path and puts it on the base URL origin', () => {
    expect(rehost('http://localhost:3000/mcp', 'https://api.example')).toBe('https://api.example/mcp');
    expect(rehost('http://api:3000/v1/mcp', 'https://api.example')).toBe('https://api.example/v1/mcp');
  });

  it('returns an unparseable endpoint unchanged', () => {
    expect(rehost('not a url', 'https://api.example')).toBe('not a url');
  });
});

describe('help', () => {
  it('says the Linux Claude Desktop path is for unofficial builds', () => {
    const program = buildProgram([(p) => register(p)]);
    const add = program.commands.find((c) => c.name() === 'agent')?.commands.find((c) => c.name() === 'add');
    expect(add?.helpInformation()).toMatch(/unofficial builds/);
  });
});

describe('agent add', () => {
  it('refuses when discovery is unreachable, and writes nothing', async () => {
    const { code, home, streams } = await invoke(['cursor'], { fetchImpl: unreachable });
    expect(code).toBe(2);
    expect(usageMessage(streams)).toContain(`Could not read ${BASE}/.well-known/mcp; refusing to write a config from memory.`);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
    expect(streams.out).toEqual([]);
  });

  it('refuses when discovery is not 2xx or does not put the key in a header', async () => {
    const down = await invoke(['cursor'], { fetchImpl: fetchStub({ error: 'down' }, 503) });
    expect(down.code).toBe(2);
    expect(existsSync(join(down.home, '.cursor', 'mcp.json'))).toBe(false);

    const query = await invoke(['cursor'], { fetchImpl: fetchStub({ ...DISCOVERY, authentication: { type: 'apiKey', in: 'query', name: 'key' } }) });
    expect(query.code).toBe(2);
    expect(existsSync(join(query.home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('needs a key before it talks to anything', async () => {
    const { code, streams } = await invoke(['cursor'], { env: { TRUESCRAPE_API_KEY: undefined } });
    expect(code).toBe(2);
    expect(usageMessage(streams)).toMatch(/No API key/);
  });

  it('writes the Cursor file with the advertised endpoint and header, owner-only, and reports the path', async () => {
    const { code, home, streams } = await invoke(['cursor']);
    expect(code).toBe(0);
    const path = join(home, '.cursor', 'mcp.json');
    expect(stdoutJson(streams)).toEqual({ target: 'cursor', path, written: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { truescrape: { url: ENDPOINT, headers: { 'x-agent-key': KEY } } } });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('writes VS Code under cwd with the servers key', async () => {
    const { code, cwd, streams } = await invoke(['vscode']);
    expect(code).toBe(0);
    const path = join(cwd, '.vscode', 'mcp.json');
    expect(stdoutJson(streams).path).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ servers: { truescrape: { type: 'http', url: ENDPOINT, headers: { 'x-agent-key': KEY } } } });
  });

  it('writes Claude Desktop under APPDATA on Windows with the cmd wrapper', async () => {
    const appdata = tmp('appdata');
    const { code, streams } = await invoke(['claude-desktop'], { platform: 'win32', env: { APPDATA: appdata } });
    expect(code).toBe(0);
    const path = join(appdata, 'Claude', 'claude_desktop_config.json');
    expect(stdoutJson(streams).path).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { truescrape: { command: 'cmd', args: ['/c', 'npx', '-y', 'truescrape', 'mcp'], env: { TRUESCRAPE_API_KEY: KEY } } },
    });
  });

  it('merges into an existing file, leaving two foreign servers and unrelated keys as they were', async () => {
    const home = tmp('home');
    const path = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const existing = {
      mcpServers: {
        alpha: { command: 'alpha', args: ['--one'] },
        beta: { url: 'https://beta.example.test', headers: { authorization: 'Bearer b' } },
      },
      other: { deep: [true, null, 'x'] },
    };
    writeFileSync(path, JSON.stringify(existing, null, 4));

    const { code } = await invoke(['cursor'], { home });
    expect(code).toBe(0);
    const merged = JSON.parse(readFileSync(path, 'utf8')) as typeof existing & { mcpServers: { truescrape: unknown } };
    expect(merged.mcpServers.alpha).toEqual(existing.mcpServers.alpha);
    expect(merged.mcpServers.beta).toEqual(existing.mcpServers.beta);
    expect(merged.other).toEqual(existing.other);
    expect(merged.mcpServers.truescrape).toEqual({ url: ENDPOINT, headers: { 'x-agent-key': KEY } });
  });

  it('refuses an existing file that is not valid JSON and leaves it untouched', async () => {
    const home = tmp('home');
    const path = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, '{ "mcpServers": { "alpha": ');

    const { code, streams } = await invoke(['cursor'], { home });
    expect(code).toBe(2);
    expect(usageMessage(streams)).toContain(path);
    expect(readFileSync(path, 'utf8')).toBe('{ "mcpServers": { "alpha": ');
  });

  it.skipIf(!canSymlink)('refuses to write through a symlink', async () => {
    const home = tmp('home');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const real = join(home, 'real.json');
    writeFileSync(real, '{}');
    const path = join(home, '.cursor', 'mcp.json');
    symlinkSync(real, path, 'file');

    const { code, streams } = await invoke(['cursor'], { home });
    expect(code).toBe(2);
    expect(usageMessage(streams)).toMatch(/symlink/);
    expect(readFileSync(real, 'utf8')).toBe('{}');
  });

  it('prints the merged JSON under --dry-run and writes nothing', async () => {
    const { code, home, streams } = await invoke(['cursor', '--dry-run']);
    expect(code).toBe(0);
    expect(stdoutJson(streams)).toEqual({ mcpServers: { truescrape: { url: ENDPOINT, headers: { 'x-agent-key': KEY } } } });
    expect(existsSync(join(home, '.cursor'))).toBe(false);
  });

  it('prints the claude command when claude is not on PATH', async () => {
    const exec = vi.fn(() => ({ status: 0 }));
    const { code, streams } = await invoke(['claude-code'], { which: () => false, exec });
    expect(code).toBe(0);
    expect(streams.out.join('')).toBe(`claude mcp add --transport http truescrape ${ENDPOINT} --header "x-agent-key: ${KEY}" --scope user\n`);
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs claude when it is on PATH, with project scope under --project', async () => {
    const exec = vi.fn(() => ({ status: 0 }));
    const which = vi.fn((cmd: string) => cmd === 'claude');
    const { code } = await invoke(['claude-code', '--project'], { which, exec });
    expect(code).toBe(0);
    expect(which).toHaveBeenCalledWith('claude');
    expect(exec).toHaveBeenCalledWith('claude', ['mcp', 'add', '--transport', 'http', 'truescrape', ENDPOINT, '--header', `x-agent-key: ${KEY}`, '--scope', 'project']);
  });

  it('exits with the status claude returned', async () => {
    const { code } = await invoke(['claude-code'], { which: () => true, exec: () => ({ status: 7 }) });
    expect(code).toBe(7);
  });

  it('never runs claude under --dry-run', async () => {
    const exec = vi.fn(() => ({ status: 0 }));
    const { streams } = await invoke(['claude-code', '--dry-run'], { which: () => true, exec });
    expect(exec).not.toHaveBeenCalled();
    expect(streams.out.join('')).toMatch(/^claude mcp add /);
  });

  it('rejects an unknown target and names the four it knows', async () => {
    const { code, streams } = await invoke(['emacs']);
    expect(code).toBe(2);
    const message = usageMessage(streams);
    for (const target of ['claude-code', 'claude-desktop', 'cursor', 'vscode']) expect(message).toContain(target);
  });
});
