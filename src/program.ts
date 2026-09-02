import { Command, Option } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { FORMATS } from './output.js';

export type Register = (program: Command) => void;

/**
 * Builds the commander program without parsing, so tests can construct one
 * per case. Every command module exports `register(program)` and is listed
 * in `registrations`; nothing registers itself on import.
 */
export function buildProgram(registrations: Register[] = defaultRegistrations): Command {
  const program = new Command();

  program
    .name('truescrape')
    .description('Public social media data from every platform in the catalogue. One key, one schema.')
    .version(pkg.version, '-v, --version')
    .showHelpAfterError()
    .configureOutput({
      // Data goes to stdout; everything commander says goes to stderr so pipes stay clean.
      writeOut: (str) => process.stderr.write(str),
      writeErr: (str) => process.stderr.write(str),
    })
    .option('--api-key <key>', 'API key for this request only. Visible in shell history; prefer `auth login` or TRUESCRAPE_API_KEY')
    .option('--base-url <url>', 'API base URL. Default: TRUESCRAPE_BASE_URL, else https://api.truescrape.com')
    .addOption(new Option('--format <format>', 'Output format').choices(FORMATS).default('json'))
    .option('--pretty', 'Indent JSON output')
    .option('--envelope', 'Print { data, meta, pagination } instead of data alone')
    .option('--output <path>', 'Write the output to a file and print only its path')
    .option('--quiet', 'Suppress the billing line on stderr')
    .option('--no-color', 'Disable colours')
    .option('--verbose', 'Show request URL, status and timing on stderr');

  for (const register of registrations) register(program);
  return program;
}

/** Filled in as command modules land; each is one import and one entry. */
export const defaultRegistrations: Register[] = [];
