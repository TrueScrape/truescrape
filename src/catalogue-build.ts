/**
 * Turns the API's OpenAPI document into the catalogue the CLI runs on.
 *
 * Shared by the generator script (build time) and the runtime refresh, so the
 * committed snapshot and a live refresh can never disagree on the mapping.
 */

export interface CatalogueParam {
  name: string;
  flag: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  enum?: string[];
  default?: string | number | boolean;
  description?: string;
}

export interface CatalogueEndpoint {
  name: string;
  platform: string;
  action: string;
  path: string;
  summary: string;
  description: string;
  credits: number;
  cacheable: boolean;
  batchable: boolean;
  experimental: boolean;
  constraints: string[];
  params: CatalogueParam[];
}

export interface Catalogue {
  generatedAt: string;
  source: string;
  endpoints: CatalogueEndpoint[];
}

/* Minimal view of the OpenAPI shapes we read; anything else is ignored. */
interface OpenApiParam {
  name: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
    enum?: unknown[];
    default?: unknown;
    description?: string;
  };
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParam[];
  [extension: string]: unknown;
}

export interface OpenApiDoc {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const BOILERPLATE = [/^\*\*Cost:\*\*/, /^\*\*Cache hits cost/, /^Failed and empty/, /^\*\*Required:\*\*/];

/** The endpoint's own prose, without the billing lines the spec repeats on every operation. */
export function cleanDescription(text: string | undefined): string {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !BOILERPLATE.some((re) => re.test(line)))
    .join(' ');
}

export function toFlag(name: string): string {
  return name.replace(/_/g, '-');
}

function kebab(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Platform is always the tag. Action is the path remainder when the path is
 * under /v1/<platform>/; a handful of paths have no such segment
 * (/v1/linktree, /v1/detect-age-gender), and for those the operationId's
 * action part is used.
 */
export function platformAndAction(path: string, operation: OpenApiOperation): { platform: string; action: string } {
  const platform = operation.tags?.[0];
  const operationId = operation.operationId ?? '';
  if (!platform) throw new Error(`Operation ${operationId || path} has no tag`);

  const prefix = `/v1/${platform}/`;
  if (path.startsWith(prefix)) {
    return { platform, action: path.slice(prefix.length).split('/').filter(Boolean).join('-') };
  }

  const underscore = operationId.indexOf('_');
  if (underscore < 0) throw new Error(`Cannot derive an action for ${path} (operationId "${operationId}")`);
  return { platform, action: kebab(operationId.slice(underscore + 1)) };
}

function paramType(schema: OpenApiParam['schema']): CatalogueParam['type'] {
  switch (schema?.type) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

export function buildParam(param: OpenApiParam): CatalogueParam {
  const out: CatalogueParam = {
    name: param.name,
    flag: toFlag(param.name),
    type: paramType(param.schema),
    required: param.required === true,
  };
  const values = param.schema?.enum;
  if (Array.isArray(values) && values.length) out.enum = values.map(String);
  const fallback = param.schema?.default;
  if (typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean') out.default = fallback;
  // The API puts descriptions on the schema today; the spec allows either place.
  const description = param.description ?? param.schema?.description;
  if (description) out.description = description;
  return out;
}

export function buildCatalogue(spec: OpenApiDoc, source: string, now: Date): Catalogue {
  const endpoints: CatalogueEndpoint[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method.toLowerCase() !== 'get') continue;
      const operationId = operation.operationId;
      if (!operationId) throw new Error(`${path} has no operationId`);
      const { platform, action } = platformAndAction(path, operation);
      const constraints = operation['x-parameter-constraints'];

      endpoints.push({
        name: operationId.replace(/_/g, '.'),
        platform,
        action,
        path,
        summary: operation.summary ?? action,
        description: cleanDescription(operation.description),
        credits: Number(operation['x-credit-cost'] ?? 1),
        cacheable: operation['x-cacheable'] === true,
        batchable: operation['x-batchable'] === true,
        experimental: operation['x-experimental'] === true,
        constraints: Array.isArray(constraints) ? constraints.map(String) : [],
        params: (operation.parameters ?? []).filter((p) => (p.in ?? 'query') === 'query').map(buildParam),
      });
    }
  }

  endpoints.sort((a, b) => a.platform.localeCompare(b.platform) || a.action.localeCompare(b.action));

  return { generatedAt: now.toISOString(), source, endpoints };
}
