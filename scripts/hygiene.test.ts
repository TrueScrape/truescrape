import { describe, expect, it } from 'vitest';
import { checkFiles } from './hygiene.js';

// Throwaway terms; the real list lives outside the repository.
const DENYLIST = ['zzz-secret-vendor', 'Internal Codename'];

describe('hygiene guard', () => {
  it('passes a clean repository', () => {
    const findings = checkFiles(
      [
        { path: 'README.md', content: '# TrueScrape\n\nSet TRUESCRAPE_API_KEY and go.\n' },
        { path: 'src/index.ts', content: 'export const x = 1;\n' },
      ],
      DENYLIST,
    );
    expect(findings).toEqual([]);
  });

  it('fails on a denylisted term, case-insensitively', () => {
    const findings = checkFiles([{ path: 'docs/a.md', content: 'we use ZZZ-Secret-Vendor here\n' }], DENYLIST);
    expect(findings).toMatchObject([{ path: 'docs/a.md', line: 1, rule: 'denylist' }]);
  });

  it('fails on an environment variable the CLI does not define', () => {
    const findings = checkFiles([{ path: 'src/x.ts', content: 'process.env.TRUESCRAPE_PROXY_URL\n' }], DENYLIST);
    expect(findings).toMatchObject([{ rule: 'env-var', text: 'TRUESCRAPE_PROXY_URL' }]);
  });

  it('fails on a committed .env file', () => {
    const findings = checkFiles([{ path: '.env.local', content: 'X=1\n' }], DENYLIST);
    expect(findings).toMatchObject([{ rule: 'env-file' }]);
  });

  it('fails on a typed count in prose but allows one inside a generated block', () => {
    const typed = checkFiles([{ path: 'README.md', content: 'We have 173 endpoints today.\n' }], DENYLIST);
    expect(typed).toMatchObject([{ rule: 'typed-count' }]);

    const generated = checkFiles(
      [
        {
          path: 'README.md',
          content: '<!-- catalogue:start -->\n173 endpoints across 28 platforms\n<!-- catalogue:end -->\n',
        },
      ],
      DENYLIST,
    );
    expect(generated).toEqual([]);
  });

  it('does not scan itself', () => {
    const findings = checkFiles([{ path: 'scripts/hygiene.ts', content: 'zzz-secret-vendor\n' }], DENYLIST);
    expect(findings).toEqual([]);
  });
});
