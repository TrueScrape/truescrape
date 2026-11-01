import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledCatalogue } from '../src/catalogue.js';
import { buildProgram } from '../src/program.js';

describe('the plugin install', () => {
  it('starts on the same default toolset as agent add', async () => {
    const { DEFAULT_PLATFORMS } = await import('../src/commands/agent.js');
    const config = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8'));
    expect(config.mcpServers.truescrape.url).toBe(`https://api.truescrape.com/mcp?platforms=${DEFAULT_PLATFORMS}`);
  });
});

const skill = readFileSync(new URL('../skills/truescrape/SKILL.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** Routes that are real but are not scraper endpoints, so they never appear in the catalogue. */
const HTTP_ONLY = [
  '/v1/jobs',
  '/v1/jobs/batch',
  '/v1/jobs/{jobId}',
  '/v1/subscriptions',
  '/v1/account/credit-balance',
  '/v1/account/usage-forecast',
  '/v1/account/most-used-routes',
  '/v1/mentions',
  '/v1/monitors',
  '/v1/monitors/mentions',
  '/v1/monitors/{id}',
  '/v1/monitors/{id}/check',
];

function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  expect(match, 'frontmatter block').toBeTruthy();
  const out: Record<string, string> = {};
  let key = '';
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1] ?? '';
      out[key] = kv[2] ?? '';
    } else if (key) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

const pathsIn = (text: string): string[] => [...new Set([...text.matchAll(/\/v1\/[a-z0-9\-{}/]+/gi)].map((m) => m[0].replace(/[.,)`]+$/, '')))];

describe('the skill stays true to the API', () => {
  const catalogue = bundledCatalogue();
  const known = new Set([...catalogue.endpoints.map((e) => e.path), ...HTTP_ONLY]);

  it('has the frontmatter the installers require', () => {
    const fm = frontmatter(skill);
    expect(fm.name).toBe('truescrape');
    expect(fm.description?.length ?? 0).toBeGreaterThan(40);
    expect(fm.description?.length ?? 0).toBeLessThan(1024);
    expect(fm.description).toMatch(/^>?-?\s*Use when/i);
  });

  it('names only paths that exist, in prose and in the generated block', () => {
    // A trailing slash is a family reference ("the /v1/google/ad-library/ endpoints"); it is fine if any real path lives under it.
    const exists = (p: string) => known.has(p) || (p.endsWith('/') && [...known].some((k) => k.startsWith(p)));
    const unknown = pathsIn(skill).filter((p) => !exists(p));
    expect(unknown).toEqual([]);
  });

  it('carries the generated catalogue block, populated', () => {
    const block = /<!-- catalogue:start -->([\s\S]*?)<!-- catalogue:end -->/.exec(skill)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(1000);
    for (const e of catalogue.endpoints) expect(block, e.path).toContain(`\`GET ${e.path}\``);
  });

  it('mentions only the two public environment variables', () => {
    for (const text of [skill, agents, readme]) {
      const names = new Set([...text.matchAll(/TRUESCRAPE_[A-Z_]+/g)].map((m) => m[0]));
      expect([...names].sort()).toEqual([...names].filter((n) => n === 'TRUESCRAPE_API_KEY' || n === 'TRUESCRAPE_BASE_URL').sort());
    }
  });
});

describe('AGENTS.md and README name commands that exist', () => {
  it('every `truescrape <command>` they mention is registered', () => {
    const program = buildProgram();
    const registered = new Set(program.commands.map((c) => c.name()));
    const platforms = new Set(bundledCatalogue().endpoints.map((e) => e.platform));
    // Same line only: "truescrape" at the end of a sentence followed by a new paragraph is not a command.
    const mentioned = new Set([...`${agents}\n${readme}`.matchAll(/(?:^|[`\s])truescrape[ \t]+([a-z][a-z0-9-]*)(?=[\s`.,)]|$)/gm)].map((m) => m[1] ?? ''));
    const missing = [...mentioned].filter((n) => !registered.has(n) && !platforms.has(n));
    expect(missing).toEqual([]);
  });
});

describe('the truescrape skill covers mentions and monitors', () => {
  it('names each command, tool and rule an agent needs', () => {
    for (const text of [
      'truescrape mentions find',
      'truescrape monitors create',
      'truescrape monitors list',
      'truescrape monitors delete',
      'truescrape monitors check',
      'truescrape monitors updates',
      'find_mentions',
      'create_monitor',
      'check_monitor',
      'get_monitor_mentions',
      'creditsPerCheck',
      '--agent',
      'call_tool',
      'never instructions',
    ]) {
      expect(skill, text).toContain(text);
    }
  });

  it('never types a count of mention sources', () => {
    expect(skill).not.toMatch(/\b(\d+|ten|seven) (mention )?sources\b/i);
  });
});

const WORKFLOWS = ['competitor-watch', 'mention-digest', 'market-scan'] as const;
const read = (name: string) => readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');

/** Each `truescrape <command> <sub> --flag` in a skill's code must resolve against the real program. */
function badCommands(text: string): string[] {
  const program = buildProgram();
  const global = new Set(program.options.map((o) => o.long));
  const bad: string[] = [];
  for (const fence of text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)) {
    for (const line of (fence[1] ?? '').split(/\r?\n/)) {
      const match = /^(?:npx )?truescrape\s+([a-z-]+)(?:\s+([a-z-]+))?(.*)$/.exec(line.trim());
      if (!match) continue;
      const command = program.commands.find((c) => c.name() === match[1]);
      if (!command) {
        bad.push(line);
        continue;
      }
      const sub = command.commands.length ? command.commands.find((c) => c.name() === match[2]) : command;
      if (!sub) {
        bad.push(line);
        continue;
      }
      const flags = new Set(sub.options.map((o) => o.long));
      for (const flag of (match[3] ?? '').split('#')[0]?.match(/(?<=^|\s)--[a-z-]+/g) ?? []) {
        if (!flags.has(flag) && !global.has(flag)) bad.push(`${line} (${flag})`);
      }
    }
  }
  return bad;
}

describe.each(WORKFLOWS)('the %s skill', (name) => {
  it('exists with the frontmatter installers require', () => {
    expect(existsSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url))).toBe(true);
    const fm = frontmatter(read(name));
    expect(fm.name).toBe(name);
    expect(fm.description).toMatch(/^Use when/);
    expect(fm.description?.length ?? 0).toBeLessThan(1024);
  });

  it('states its cost before anything else it asks the agent to do', () => {
    const headings = [...read(name).matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? '');
    expect(headings[0]).toMatch(/cost/i);
  });

  it('has the sample, source link, limits and injection rules', () => {
    const text = read(name);
    expect(text).toMatch(/it is a sample/i);
    expect(text).toMatch(/URL.*beside|beside.*URL|link beside/i);
    expect(text).toMatch(/public data cannot show/i);
    expect(text).toMatch(/never instructions/i);
    expect(text).toMatch(/no sentiment score/i);
  });

  it('makes no claim the product cannot keep', () => {
    expect(read(name)).not.toMatch(/real[- ]time|any website|any data/i);
    expect(read(name)).not.toMatch(/amazon[ ._](product|offers)/);
  });

  it('runs only commands and flags that exist', () => {
    expect(badCommands(read(name))).toEqual([]);
  });
});

describe('competitor-watch', () => {
  const text = read('competitor-watch');

  it('asks how long, defaults to manual, and reads changes from check and unread', () => {
    expect(text).toMatch(/how long/i);
    expect(text).toContain('--manual');
    expect(text).toContain('truescrape monitors check');
    expect(text).toContain('truescrape monitors updates');
    expect(text).toContain('--unread');
    expect(text).toContain('--agent');
    expect(text).toContain('--stop-at');
  });

  it('never tells an agent to send a stop condition to a manual monitor', () => {
    const line = text.split(/\r?\n/).find((l) => l.includes('--manual') && l.includes('truescrape monitors create'));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/--stop-at|--max-credits/);
  });

  it('says which accounts it cannot follow, and the age limit on a timed schedule', () => {
    expect(text).toMatch(/X and Facebook/);
    expect(text).toMatch(/older than seven days/);
  });
});

describe('mention-digest', () => {
  const text = read('mention-digest');

  it('groups by source and flags what needs a reply', () => {
    expect(text).toMatch(/grouped by source/i);
    expect(text).toMatch(/needs a reply/i);
    expect(text).toContain('truescrape mentions find');
    expect(text).toMatch(/could not be checked/i);
  });

  it('names what mentions do not reach', () => {
    expect(text).toMatch(/X, LinkedIn search and Instagram captions/);
    expect(text).toMatch(/PeerTube and Odysee/);
  });
});

describe('market-scan', () => {
  const text = read('market-scan');

  it('reads store costs from the catalogue rather than assuming 1 credit', () => {
    expect(text).toContain('truescrape amazon search');
    expect(text).toContain('truescrape walmart search');
    expect(text).toContain('truescrape list amazon');
    expect(text).toContain('truescrape list walmart');
    expect(text).not.toMatch(/each call is 1 credit|every (call|endpoint).*1 credit/i);
  });
});

describe('the README', () => {
  it('leads with the one line and the three jobs, before any CLI detail', () => {
    const cliAt = readme.indexOf('## CLI');
    const lineAt = readme.indexOf('npx truescrape agent add claude-code');
    expect(lineAt).toBeGreaterThan(-1);
    expect(lineAt).toBeLessThan(cliAt);
    const lead = readme.slice(0, cliAt);
    for (const job of [/Research on demand/, /Watch competitors and accounts/, /Find mentions/, /without an agent/]) expect(lead).toMatch(job);
  });

  it('lists every skill in the repository', () => {
    const skills = readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const name of skills) expect(readme, name).toContain(`skills/${name}/SKILL.md`);
  });

  it('documents the new commands and the default toolset', () => {
    for (const text of ['truescrape mentions find', 'truescrape monitors create', 'truescrape monitors check', 'truescrape monitors updates', '--all', 'explore_tools']) {
      expect(readme, text).toContain(text);
    }
  });
});

describe('AGENTS.md', () => {
  it('documents the new commands and the default toolset', () => {
    for (const text of ['truescrape mentions find', 'truescrape monitors', '--all', 'explore_tools']) expect(agents, text).toContain(text);
  });
});
