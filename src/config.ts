import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.truescrape.com';

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
}

type Env = Record<string, string | undefined>;

/** `~/.config/truescrape` (or XDG_CONFIG_HOME) on macOS and Linux, `%APPDATA%\truescrape` on Windows. */
export function configDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'truescrape');
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'truescrape');
}

export function configPath(env?: Env, platform?: NodeJS.Platform): string {
  return join(configDir(env, platform), 'config.json');
}

export function cachePath(env?: Env, platform?: NodeJS.Platform): string {
  return join(configDir(env, platform), 'catalogue-cache.json');
}

export function readConfig(path: string): StoredConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const { apiKey, baseUrl } = parsed as Record<string, unknown>;
    return {
      ...(typeof apiKey === 'string' ? { apiKey } : {}),
      ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
    };
  } catch {
    return {};
  }
}

/** Atomic and owner-only: a crash mid-write leaves the old file, and the key is never world-readable. */
export function writeConfig(path: string, config: StoredConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export type KeySource = 'flag' | 'env' | 'config' | 'none';
export type UrlSource = 'flag' | 'env' | 'config' | 'default';

export interface Settings {
  apiKey?: string;
  keySource: KeySource;
  baseUrl: string;
  baseUrlSource: UrlSource;
}

export interface ResolveInput {
  flagKey?: string;
  flagBaseUrl?: string;
  env?: Env;
  configFile?: string;
}

/**
 * Flag, then environment, then the config file. CI and agents set the
 * environment, so a stale stored key must never win over it.
 */
export function resolveSettings(input: ResolveInput = {}): Settings {
  const env = input.env ?? process.env;
  const stored = readConfig(input.configFile ?? configPath(env));

  let apiKey: string | undefined;
  let keySource: KeySource = 'none';
  if (input.flagKey) [apiKey, keySource] = [input.flagKey, 'flag'];
  else if (env.TRUESCRAPE_API_KEY) [apiKey, keySource] = [env.TRUESCRAPE_API_KEY, 'env'];
  else if (stored.apiKey) [apiKey, keySource] = [stored.apiKey, 'config'];

  let baseUrl = DEFAULT_BASE_URL;
  let baseUrlSource: UrlSource = 'default';
  if (input.flagBaseUrl) [baseUrl, baseUrlSource] = [input.flagBaseUrl, 'flag'];
  else if (env.TRUESCRAPE_BASE_URL) [baseUrl, baseUrlSource] = [env.TRUESCRAPE_BASE_URL, 'env'];
  else if (stored.baseUrl) [baseUrl, baseUrlSource] = [stored.baseUrl, 'config'];

  return { apiKey, keySource, baseUrl: baseUrl.replace(/\/$/, ''), baseUrlSource };
}
