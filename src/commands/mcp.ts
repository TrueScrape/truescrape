import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { Client, NetworkError } from '../client.js';
import { requireKey, run, type Context, type ContextOverrides } from '../context.js';

/**
 * `truescrape mcp` is a transport, nothing more. The API already serves MCP
 * over HTTP at POST /mcp; clients that can only launch a stdio server get this
 * process, which forwards each stdin line there and prints the answer as one
 * line. Every failure it cannot forward becomes a JSON-RPC error so the client
 * never has to parse prose, and stdout carries nothing else.
 */

export interface BridgeOverrides extends ContextOverrides {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

type JsonRpcId = string | number | null;

/** Why a line could not be answered by the server; `status` is absent when there was no response. */
export interface Failure {
  code: string;
  message: string;
  status?: number;
}

/** JSON-RPC reserves -32000 for server-defined errors; the API's own code rides in `data`. */
const SERVER_ERROR = -32000;

function idOf(message: unknown): JsonRpcId | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const id = (message as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : undefined;
}

function isJsonRpc(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isJsonRpc);
  return Boolean(value) && typeof value === 'object' && (value as { jsonrpc?: unknown }).jsonrpc === '2.0';
}

function errorFor(id: JsonRpcId, failure: Failure) {
  const data = failure.status === undefined ? { code: failure.code } : { code: failure.code, status: failure.status };
  return { jsonrpc: '2.0', id, error: { code: SERVER_ERROR, message: failure.message, data } };
}

/**
 * The error line owed for an input line: one per element carrying an id, or
 * nothing for notifications. A line that was not JSON gets id null, as the
 * JSON-RPC spec requires when the id cannot be read.
 */
export function errorLine(input: string, failure: Failure): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return JSON.stringify(errorFor(null, failure));
  }
  if (Array.isArray(parsed)) {
    const errors = parsed.map(idOf).filter((id): id is JsonRpcId => id !== undefined).map((id) => errorFor(id, failure));
    return errors.length ? JSON.stringify(errors) : null;
  }
  const id = idOf(parsed);
  return id === undefined ? null : JSON.stringify(errorFor(id, failure));
}

function failureFrom(status: number, body: string, baseUrl: string): Failure {
  try {
    const envelope = JSON.parse(body) as { success?: boolean; error?: { code?: string; message?: string } };
    if (envelope?.success === false && envelope.error?.code && envelope.error.message) {
      return { code: envelope.error.code, message: envelope.error.message, status };
    }
  } catch {
    // Not JSON: an edge proxy answered for the API. Report the status, never a guessed code.
  }
  return { code: 'upstream_unavailable', message: `HTTP ${status} from ${baseUrl}`, status };
}

/**
 * One stdin line in, one stdout line (or nothing) out. Pure apart from the
 * request itself, so the shaping rules are testable without a process.
 */
export async function bridgeLine(line: string, client: Client, baseUrl: string, warn: (text: string) => void = () => {}): Promise<string | null> {
  let response: Response;
  try {
    response = await client.raw('POST', '/mcp', line, { 'content-type': 'application/json' });
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    warn(`network: ${err.message}`);
    return errorLine(line, { code: 'network', message: err.message });
  }

  // 202 and 204 are how the server acknowledges notifications; there is nothing to relay.
  if (response.status === 202 || response.status === 204) return null;
  const body = await response.text();
  if (!body.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }

  // The server already spoke JSON-RPC (a 400 parse error, say): relay it rather than wrap it.
  if (parsed !== undefined && (response.ok || isJsonRpc(parsed))) return JSON.stringify(parsed);

  const failure = failureFrom(response.status, body, baseUrl);
  warn(`${failure.code}: ${failure.message}`);
  return errorLine(line, failure);
}

export async function runBridge(ctx: Context, stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Promise<void> {
  requireKey(ctx);
  const baseUrl = ctx.client.baseUrl;
  const warn = ctx.output.quiet ? () => {} : (text: string) => ctx.streams.stderr(`mcp: ${text}\n`);
  warn(`bridging stdio to ${baseUrl}/mcp`);

  // The async iterator hands over one line at a time, which is what keeps responses in request order.
  const lines = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const out = await bridgeLine(line, ctx.client, baseUrl, warn);
    if (out !== null) stdout.write(`${out}\n`);
  }
}

export function register(program: Command, overrides: BridgeOverrides = {}): void {
  program
    .command('mcp')
    .description('Serve MCP over stdio for clients that launch a local process, bridging every message to the API')
    .addHelpText(
      'after',
      `
Point any MCP client that spawns a stdio server at this command:
  { "command": "npx", "args": ["-y", "truescrape", "mcp"], "env": { "TRUESCRAPE_API_KEY": "..." } }

Clients that can call a remote server directly need no bridge: use <base-url>/mcp with the x-api-key header.
Only JSON-RPC lines are written to stdout; diagnostics go to stderr.`,
    )
    .action(async function (this: Command) {
      await run(this, (ctx) => runBridge(ctx, overrides.stdin ?? process.stdin, overrides.stdout ?? process.stdout), overrides);
    });
}
