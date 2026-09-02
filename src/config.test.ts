import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL, configDir, readConfig, resolveSettings, writeConfig } from './config.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ts-cfg-'));

describe('config location', () => {
  it('uses APPDATA on Windows and XDG or ~/.config elsewhere', () => {
    expect(configDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32')).toMatch(/AppData[\\/]Roaming[\\/]truescrape$/);
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toMatch(/^[\\/]xdg[\\/]truescrape$/);
    expect(configDir({}, 'darwin')).toMatch(/[\\/]\.config[\\/]truescrape$/);
  });
});

describe('config file', () => {
  it('round-trips, creates the directory, and is owner-only', () => {
    const path = join(tmp(), 'nested', 'config.json');
    writeConfig(path, { apiKey: 'k', baseUrl: 'https://x' });
    expect(readConfig(path)).toEqual({ apiKey: 'k', baseUrl: 'https://x' });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('treats a missing or corrupt file as empty', () => {
    const dir = tmp();
    expect(readConfig(join(dir, 'none.json'))).toEqual({});
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(readConfig(bad)).toEqual({});
    writeFileSync(bad, JSON.stringify({ apiKey: 42, baseUrl: 'ok' }));
    expect(readConfig(bad)).toEqual({ baseUrl: 'ok' });
  });

  it('never leaves a partial file behind: the write is a rename', () => {
    const path = join(tmp(), 'config.json');
    writeConfig(path, { apiKey: 'first' });
    writeConfig(path, { apiKey: 'second' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ apiKey: 'second' });
  });
});

describe('precedence', () => {
  it('flag beats environment beats config file', () => {
    const file = join(tmp(), 'config.json');
    writeConfig(file, { apiKey: 'from-file', baseUrl: 'https://file' });
    const env = { TRUESCRAPE_API_KEY: 'from-env', TRUESCRAPE_BASE_URL: 'https://env/' };

    expect(resolveSettings({ flagKey: 'from-flag', flagBaseUrl: 'https://flag', env, configFile: file })).toEqual({
      apiKey: 'from-flag',
      keySource: 'flag',
      baseUrl: 'https://flag',
      baseUrlSource: 'flag',
    });
    expect(resolveSettings({ env, configFile: file })).toMatchObject({ keySource: 'env', baseUrl: 'https://env', baseUrlSource: 'env' });
    expect(resolveSettings({ env: {}, configFile: file })).toMatchObject({ apiKey: 'from-file', keySource: 'config', baseUrlSource: 'config' });
  });

  it('reports no key and the default base URL when nothing is set', () => {
    expect(resolveSettings({ env: {}, configFile: join(tmp(), 'none.json') })).toEqual({
      apiKey: undefined,
      keySource: 'none',
      baseUrl: DEFAULT_BASE_URL,
      baseUrlSource: 'default',
    });
  });
});
