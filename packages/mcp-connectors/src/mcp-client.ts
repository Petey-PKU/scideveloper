import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExternalMcpServerConfig, McpToolDescriptor } from '@scideveloper/shared';

const protocolVersion = '2024-11-05';
const supportedVersions = new Set([protocolVersion, '2025-03-26', '2025-06-18', '2025-11-25']);
const timeoutMs = 12_000;
const shutdownGraceMs = 250;

type JsonObject = Record<string, unknown>;
type RpcMessage = { jsonrpc: '2.0'; id?: number; method: string; params?: JsonObject };

interface Transport {
  request(message: RpcMessage & { id: number }): Promise<unknown>;
  notify(message: RpcMessage): Promise<void>;
  setProtocolVersion?(version: string): void;
  close(): Promise<void>;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isResponse(message: unknown, id: number): message is JsonObject {
  return isObject(message) && message.id === id && !Object.hasOwn(message, 'method');
}

function responseResult(message: JsonObject): unknown {
  const hasResult = Object.hasOwn(message, 'result');
  const hasError = Object.hasOwn(message, 'error');
  if (message.jsonrpc !== '2.0' || hasResult === hasError) {
    throw new Error('Invalid MCP JSON-RPC response');
  }
  if (hasResult) return message.result;
  const error = message.error;
  if (!isObject(error) || !Number.isInteger(error.code) || typeof error.message !== 'string') {
    throw new Error('Invalid MCP JSON-RPC error');
  }
  throw new Error(`MCP JSON-RPC error ${error.code}: ${error.message}`);
}

function stdioTransport(config: ExternalMcpServerConfig, signal: AbortSignal): Transport {
  if (!config.command?.trim()) throw new Error('MCP stdio transport requires a command');
  const child = spawn(config.command, config.args ?? [], {
    env: { ...process.env, ...config.env }, stdio: 'pipe', windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let pending: { id: number; resolve: (value: unknown) => void; reject: (error: unknown) => void } | undefined;
  let failure: unknown;
  let stderr = '';

  function fail(error: unknown) {
    failure ??= error;
    pending?.reject(failure);
    pending = undefined;
  }
  async function write(message: JsonObject): Promise<void> {
    if (failure) throw failure;
    signal.throwIfAborted();
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      const onWriteAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onWriteAbort, { once: true });
      child.stdin.write(line, error => {
        signal.removeEventListener('abort', onWriteAbort);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  const onAbort = () => fail(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
  const closed = new Promise<void>(resolve => {
    child.once('close', (code, exitSignal) => {
      const detail = stderr.trim();
      fail(new Error(`MCP server closed (${exitSignal ?? code})${detail ? `: ${detail}` : ''}`));
      resolve();
    });
  });

  lines.on('line', line => {
    if (!line.trim()) return;
    try {
      const message: unknown = JSON.parse(line);
      if (pending && isResponse(message, pending.id)) {
        pending.resolve(responseResult(message));
        pending = undefined;
      } else if (isObject(message) && message.jsonrpc === '2.0' && typeof message.method === 'string'
        && (typeof message.id === 'number' || typeof message.id === 'string')) {
        const payload = message.method === 'ping' ? { result: {} }
          : { error: { code: -32601, message: 'Method not found' } };
        void write({ jsonrpc: '2.0', id: message.id, ...payload }).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  });

  return {
    request(message) {
      return new Promise((resolve, reject) => {
        pending = { id: message.id, resolve, reject };
        void write(message).catch(fail);
      });
    },
    notify: write,
    async close() {
      signal.removeEventListener('abort', onAbort);
      child.stdin.end();
      const exited = await Promise.race([closed.then(() => true), delay(shutdownGraceMs, false, { ref: false })]);
      if (!exited) {
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await Promise.race([closed, delay(shutdownGraceMs, undefined, { ref: false })]);
      }
      lines.close();
    },
  };
}

async function readEventStream(response: Response, id: number): Promise<JsonObject> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing MCP event stream body');
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];

  function dispatch(): JsonObject | undefined {
    if (!data.length) return;
    const message: unknown = JSON.parse(data.join('\n'));
    data = [];
    if (isResponse(message, id)) return message;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // A CR at the end of a chunk may be the first half of CRLF.
      const complete = done || !buffer.endsWith('\r') ? buffer : buffer.slice(0, -1);
      const lines = complete.split(/\r\n|\r|\n/);
      const trailing = lines.pop()!;
      if (done) lines.push(trailing, '');
      buffer = trailing + buffer.slice(complete.length);
      for (const line of lines) {
        if (line.startsWith('data:') || line === 'data') {
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (line === '') {
          const message = dispatch();
          if (message) return message;
        }
      }
      if (done) throw new Error('MCP event stream closed before the matching response');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function httpTransport(config: ExternalMcpServerConfig, signal: AbortSignal, credential?: string): Transport {
  if (!config.url?.trim()) throw new Error('MCP HTTP transport requires a URL');
  const url = new URL(config.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Expected an HTTP or HTTPS MCP URL');
  const headers = new Headers(config.headers);
  if (credential && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${credential}`);
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json, text/event-stream');
  let sessionId: string | null = null;

  async function post(message: RpcMessage): Promise<Response> {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message), signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`MCP HTTP ${response.status} for ${message.method}`);
    }
    if (message.method === 'initialize') {
      sessionId = response.headers.get('Mcp-Session-Id');
      if (sessionId) headers.set('Mcp-Session-Id', sessionId);
    }
    return response;
  }

  return {
    async request(message) {
      const response = await post(message);
      const type = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
      const payload: unknown = type === 'text/event-stream' ? await readEventStream(response, message.id) : await response.json();
      if (!isResponse(payload, message.id)) throw new Error(`Missing matching JSON-RPC response for ${message.method}`);
      return responseResult(payload);
    },
    async notify(message) {
      const response = await post(message);
      await response.body?.cancel();
    },
    setProtocolVersion(version) { headers.set('MCP-Protocol-Version', version); },
    async close() {
      if (!sessionId) return;
      try {
        const response = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(shutdownGraceMs) });
        await response.body?.cancel();
      } catch {
        // Session termination is optional and must leave the operation result intact.
      }
    },
  };
}

async function withMcpSession<T>(
  config: ExternalMcpServerConfig,
  run: (request: (method: string, params?: JsonObject) => Promise<unknown>) => Promise<T>,
  credential?: string,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  let transport: Transport | undefined;
  try {
    transport = config.transport === 'stdio' ? stdioTransport(config, signal) : httpTransport(config, signal, credential);
    const session = transport;
    let id = 0;
    const request = (method: string, params?: JsonObject) => {
      signal.throwIfAborted();
      return session.request({ jsonrpc: '2.0', id: ++id, method, params });
    };
    const initialized = await request('initialize', {
      protocolVersion, capabilities: {}, clientInfo: { name: 'scideveloper', version: '0.2.0' },
    });
    if (!isObject(initialized) || typeof initialized.protocolVersion !== 'string'
      || !supportedVersions.has(initialized.protocolVersion)) {
      throw new Error('MCP server returned a missing or unsupported protocol version');
    }
    session.setProtocolVersion?.(initialized.protocolVersion);
    await session.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return await run(request);
  } catch (error) {
    if (signal.aborted) throw new Error(`MCP server "${config.id}" timed out after ${timeoutMs} ms`, { cause: error });
    throw error;
  } finally {
    await transport?.close();
  }
}

export async function discoverExternalMcpTools(config: ExternalMcpServerConfig, credential?: string): Promise<McpToolDescriptor[]> {
  return withMcpSession(config, async request => {
    const tools: McpToolDescriptor[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await request('tools/list', cursor === undefined ? undefined : { cursor });
      if (!isObject(page) || !Array.isArray(page.tools)) throw new Error('Invalid MCP tools/list result');
      for (const tool of page.tools as unknown[]) {
        if (!isObject(tool) || typeof tool.name !== 'string' || !tool.name.trim()) {
          throw new Error('Invalid MCP tool descriptor');
        }
        tools.push({
          name: tool.name,
          ...(typeof tool.description === 'string' && { description: tool.description }),
          ...(isObject(tool.inputSchema) && { inputSchema: tool.inputSchema }),
        });
      }
      if (page.nextCursor !== undefined && typeof page.nextCursor !== 'string') throw new Error('Invalid MCP tool cursor');
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) throw new Error('MCP tools/list repeated a pagination cursor');
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return tools;
  }, credential);
}

export async function callExternalMcpTool(
  config: ExternalMcpServerConfig, toolName: string, args: Record<string, unknown>, credential?: string,
): Promise<unknown> {
  return withMcpSession(config, async request => {
    const result = await request('tools/call', { name: toolName, arguments: args });
    if (!isObject(result)) throw new Error('Invalid MCP tools/call result');
    const content: unknown[] | undefined = Array.isArray(result.content) ? result.content : undefined;
    if (result.isError === true) {
      const detail = content?.find(block => isObject(block) && block.type === 'text' && typeof block.text === 'string');
      const text = isObject(detail) && typeof detail.text === 'string' ? detail.text.slice(0, 2048) : '';
      throw new Error(`MCP tool "${toolName}" failed: ${text || 'no error details'}`);
    }
    if (Object.hasOwn(result, 'structuredContent')) return result.structuredContent;
    if (!content) throw new Error('Missing MCP tool content');
    const [block] = content;
    if (content.length !== 1 || !isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return content;
    try { return JSON.parse(block.text) as unknown; } catch { return block.text; }
  }, credential);
}
