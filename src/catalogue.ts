import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import snapshot from './catalogue.json' with { type: 'json' };
import { buildCatalogue, type Catalogue, type CatalogueEndpoint, type CatalogueParam, type OpenApiDoc } from './catalogue-build.js';

export type { Catalogue, CatalogueEndpoint, CatalogueParam };

/** The catalogue bundled at build time. Works with no network. */
export function bundledCatalogue(): Catalogue {
  return snapshot as Catalogue;
}

export function findEndpoint(catalogue: Catalogue, platform: string, action: string): CatalogueEndpoint | undefined {
  return catalogue.endpoints.find((e) => e.platform === platform && e.action === action);
}

export function endpointsFor(catalogue: Catalogue, platform: string): CatalogueEndpoint[] {
  return catalogue.endpoints.filter((e) => e.platform === platform);
}

export function platformsOf(catalogue: Catalogue): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of catalogue.endpoints) counts.set(e.platform, (counts.get(e.platform) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface RefreshOptions {
  baseUrl: string;
  cachePath: string;
  /** How long a cached refresh stays valid. Default one day. */
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function readCachedCatalogue(cachePath: string, maxAgeMs = DAY_MS, now: () => Date = () => new Date()): Catalogue | null {
  if (!existsSync(cachePath)) return null;
  if (now().getTime() - statSync(cachePath).mtimeMs > maxAgeMs) return null;
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as Catalogue;
  } catch {
    return null;
  }
}

/** Fetches the live OpenAPI document, rebuilds the catalogue and caches it. */
export async function refreshCatalogue(options: RefreshOptions): Promise<Catalogue> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, '')}/openapi.json`;
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  const spec = (await response.json()) as OpenApiDoc;
  const catalogue = buildCatalogue(spec, url, (options.now ?? (() => new Date()))());

  mkdirSync(dirname(options.cachePath), { recursive: true });
  const tmp = `${options.cachePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(catalogue), { mode: 0o600 });
  renameSync(tmp, options.cachePath);
  return catalogue;
}

/**
 * Bundled snapshot first, then a fresh-enough cache, then one live refresh.
 * A new endpoint is usable the day it ships without a CLI release, and the
 * common path never touches the network.
 */
export async function resolveEndpoint(
  platform: string,
  action: string,
  options: RefreshOptions,
): Promise<CatalogueEndpoint | undefined> {
  const bundled = findEndpoint(bundledCatalogue(), platform, action);
  if (bundled) return bundled;

  const cached = readCachedCatalogue(options.cachePath, options.maxAgeMs, options.now);
  if (cached) return findEndpoint(cached, platform, action);

  const fresh = await refreshCatalogue(options);
  return findEndpoint(fresh, platform, action);
}
