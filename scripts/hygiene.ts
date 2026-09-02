/**
 * Public-repo hygiene guard.
 *
 * Everything in this repository is public. This script fails the build when a
 * file carries something that should not be: a term from a denylist kept
 * OUTSIDE the repo (so the list itself is not published), an environment
 * variable the CLI does not define, a committed .env file, or a hand-typed
 * endpoint/platform count outside the generated blocks.
 *
 * Usage: TRUESCRAPE_HYGIENE_DENYLIST=/path/to/denylist.txt pnpm hygiene
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface HygieneFile {
  path: string;
  content: string;
}

export interface Finding {
  path: string;
  line: number;
  rule: 'denylist' | 'env-var' | 'env-file' | 'typed-count';
  text: string;
}

/** The only TRUESCRAPE_* names allowed to appear anywhere. */
export const ALLOWED_ENV = new Set([
  'TRUESCRAPE_API_KEY',
  'TRUESCRAPE_BASE_URL',
  'TRUESCRAPE_LIVE',
  'TRUESCRAPE_HYGIENE_DENYLIST',
]);

const GENERATED_START = '<!-- catalogue:start -->';
const GENERATED_END = '<!-- catalogue:end -->';

/** Files that legitimately mention the rules themselves. */
const SELF = new Set(['scripts/hygiene.ts', 'scripts/hygiene.test.ts']);

/**
 * Verbatim copies of public documents. Their wording is the API's to fix, not
 * this repository's; the generated catalogue built from them is still scanned.
 */
const VERBATIM_PUBLIC = /^test\/fixtures\//;

export function checkFiles(files: HygieneFile[], denylist: string[]): Finding[] {
  const findings: Finding[] = [];
  const terms = denylist.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);

  for (const file of files) {
    const path = file.path.replace(/\\/g, '/');
    if (SELF.has(path)) continue;

    if (/(^|\/)\.env(\.|$)/.test(path)) {
      findings.push({ path, line: 0, rule: 'env-file', text: path });
      continue;
    }

    let inGenerated = false;
    const lines = file.content.split(/\r?\n/);
    lines.forEach((raw, index) => {
      const line = index + 1;
      const lower = raw.toLowerCase();

      if (raw.includes(GENERATED_START)) inGenerated = true;
      if (raw.includes(GENERATED_END)) inGenerated = false;

      if (!VERBATIM_PUBLIC.test(path)) {
        for (const term of terms) {
          if (lower.includes(term)) findings.push({ path, line, rule: 'denylist', text: raw.trim() });
        }
      }

      for (const match of raw.matchAll(/TRUESCRAPE_[A-Z0-9_]+/g)) {
        if (!ALLOWED_ENV.has(match[0])) findings.push({ path, line, rule: 'env-var', text: match[0] });
      }

      // Counts are generated, never typed; a typed one is stale the day it is written.
      if (path.endsWith('.md') && !inGenerated && /\b\d[\d,]*\+?\s+(endpoints|platforms|tools)\b/i.test(raw)) {
        findings.push({ path, line, rule: 'typed-count', text: raw.trim() });
      }
    });
  }

  return findings;
}

function trackedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).filter((p) => p.length > 0 && !p.endsWith('pnpm-lock.yaml'));
}

/** Commit messages are published too. Scanned as one virtual file, one commit per block. */
function commitMessages(root: string): HygieneFile | null {
  try {
    const out = execFileSync('git', ['log', '--format=%H%n%B%n----'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length ? { path: 'git:log', content: out } : null;
  } catch {
    return null;
  }
}

function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8000).includes(0);
}

export function main(root = process.cwd()): number {
  const listPath = process.env.TRUESCRAPE_HYGIENE_DENYLIST;
  if (!listPath || !existsSync(listPath)) {
    console.error('hygiene: set TRUESCRAPE_HYGIENE_DENYLIST to the path of the denylist file (one term per line).');
    return 2;
  }
  const denylist = readFileSync(listPath, 'utf8').split(/\r?\n/).filter((t) => t.trim().length > 0);
  // An empty list would pass everything; a missing secret must fail loudly, not quietly.
  if (denylist.length === 0) {
    console.error(`hygiene: ${listPath} has no terms; refusing to run with an empty denylist.`);
    return 2;
  }

  const files: HygieneFile[] = [];
  for (const path of trackedFiles(root)) {
    const buffer = readFileSync(resolve(root, path));
    if (!isText(buffer)) continue;
    files.push({ path, content: buffer.toString('utf8') });
  }
  const log = commitMessages(root);
  if (log) files.push(log);

  const findings = checkFiles(files, denylist);
  for (const f of findings) console.error(`${f.path}:${f.line} [${f.rule}] ${f.text}`);
  if (findings.length) {
    console.error(`hygiene: ${findings.length} finding${findings.length === 1 ? '' : 's'}.`);
    return 1;
  }
  console.error(`hygiene: ${files.length} files clean.`);
  return 0;
}

if (process.argv[1] && /hygiene\.(ts|js)$/.test(process.argv[1])) {
  process.exitCode = main();
}
