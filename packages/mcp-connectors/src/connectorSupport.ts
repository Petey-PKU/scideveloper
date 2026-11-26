import type { ConnectorInfo, SpillHandle } from '@scideveloper/shared';

export interface ConnectorResponse {
  source: 'live' | 'offline-fallback';
  format: SpillHandle['format'];
  data: unknown;
  summary: string;
}

export interface ScientificConnector {
  info: ConnectorInfo;
  execute(operation: string, params: Record<string, unknown>, options?: ConnectorContext): Promise<ConnectorResponse>;
}

export interface ConnectorContext {
  allowLive?: boolean;
  credential?: string;
}

export type QueryParams = Record<string, unknown>;
type Payload = Omit<ConnectorResponse, 'source'>;
type Operation = (params: QueryParams, liveSignal?: AbortSignal, credential?: string) => Promise<Payload> | Payload;

export function defineConnector(
  info: Omit<ConnectorInfo, 'status' | 'operations'>,
  operations: Record<string, Operation>,
  liveTimeoutMs = 8000,
): ScientificConnector {
  return {
    info: { ...info, status: 'ready', operations: Object.keys(operations) },
    async execute(operation, params, options) {
      if (!Object.hasOwn(operations, operation)) {
        throw new Error(`Unsupported operation "${operation}" for connector "${info.id}"`);
      }
      const run = operations[operation];
      if (options?.allowLive === true) {
        try {
          const result = await run(params, AbortSignal.timeout(liveTimeoutMs), options.credential);
          return { ...result, source: 'live' };
        } catch (error) {
          if (error instanceof InvalidParameter || error instanceof LiveWriteError) throw error;
          // Timeouts, HTTP failures and invalid upstream data use the local fixture.
        }
      }
      return { ...await run(params), source: 'offline-fallback' };
    },
  };
}

export class InvalidParameter extends Error {}

// A failed live write can have an unknown outcome. Never repeat it against a fixture.
export class LiveWriteError extends Error {}

export function param(params: QueryParams, ...names: string[]): string {
  for (const name of names) {
    const value = params[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

export function requiredParam(params: QueryParams, ...names: string[]): string {
  const value = param(params, ...names);
  if (!value) throw new InvalidParameter(`Missing parameter "${names[0]}"`);
  return value;
}

export function limit(params: QueryParams, fallback = 10, max = 50, keys = ['limit', 'count']): number {
  const value = Number(param(params, ...keys) || fallback);
  return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.trunc(value))) : fallback;
}

export function matches(query: string, ...fields: Array<string | number>): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const haystack = normalize(fields.join(' '));
  return query.split(/\s+OR\s+/i).some(group => normalize(group).split(' ')
    .filter(word => word && word !== 'and').every(word => haystack.includes(word)));
}

export function queryUrl(endpoint: string, params: Record<string, string | number>): URL {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

export async function request(
  url: URL | string, signal: AbortSignal, init?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response;
}

export async function json<T>(url: URL | string, signal: AbortSignal): Promise<T> {
  const response = await request(url, signal, { headers: { Accept: 'application/json' } });
  return await response.json() as T;
}

export function result(data: unknown, summary: string, format: SpillHandle['format'] = 'json'): Payload {
  return { data, summary, format };
}
