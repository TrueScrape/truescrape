import pkg from '../package.json' with { type: 'json' };

export interface Meta {
  creditsCharged?: number;
  cached?: boolean;
  cacheAgeSeconds?: number | null;
  durationMs?: number;
  requestId?: string;
}

export interface Pagination {
  cursor: string | null;
  hasMore: boolean;
  count: number;
}

/** What every successful API response carries, minus the `success` flag. */
export interface Envelope<T = unknown> {
  data: T;
  meta?: Meta;
  pagination?: Pagination;
  status: number;
}

/** The API said no. `code` is the API's own error code and is never invented here. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The API could not be reached at all: DNS, refused, timeout. */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestInfo {
  method: string;
  url: string;
  status?: number;
  durationMs: number;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called after every request; used by --verbose. */
  onRequest?: (info: RequestInfo) => void;
}

export const USER_AGENT = `truescrape-cli/${pkg.version}`;

export function buildQuery(query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export class Client {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, '');
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}),
      ...extra,
    };
  }

  async get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<Envelope<T>> {
    return this.request<T>('GET', `${path}${buildQuery(query)}`);
  }

  async post<T = unknown>(path: string, body: unknown): Promise<Envelope<T>> {
    return this.request<T>('POST', path, JSON.stringify(body), { 'content-type': 'application/json' });
  }

  /** Raw response for callers that speak their own protocol over the API, such as the MCP bridge. */
  async raw(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const started = Date.now();
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: this.headers(headers),
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.options.onRequest?.({ method, url, status: response.status, durationMs: Date.now() - started });
      return response;
    } catch (err) {
      this.options.onRequest?.({ method, url, durationMs: Date.now() - started });
      const reason = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`Could not reach ${url}: ${reason}`, { cause: err });
    }
  }

  private async request<T>(method: string, path: string, body?: string, headers?: Record<string, string>): Promise<Envelope<T>> {
    const response = await this.raw(method, path, body, headers);
    const requestId = response.headers.get('x-request-id') ?? undefined;
    const text = await response.text();

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // An edge proxy answering for the API sends HTML; report the status, never a guessed code.
      throw new ApiError('upstream_unavailable', response.status, `HTTP ${response.status} with a non-JSON body from ${this.baseUrl}`, undefined, requestId);
    }

    const envelope = (parsed ?? {}) as {
      success?: boolean;
      data?: T;
      meta?: Meta;
      pagination?: Pagination;
      error?: { code?: string; message?: string; details?: unknown };
    };

    if (!response.ok || envelope.success === false) {
      const code = envelope.error?.code ?? `http_${response.status}`;
      const message = envelope.error?.message ?? `HTTP ${response.status}`;
      throw new ApiError(code, response.status, message, envelope.error?.details, requestId ?? envelope.meta?.requestId);
    }

    return {
      data: envelope.data as T,
      meta: envelope.meta,
      pagination: envelope.pagination,
      status: response.status,
    };
  }
}
