import { join } from 'node:path';
import type { ConnectorInfo, ConnectorQueryResult, ExternalMcpServerConfig, McpToolDescriptor } from '@scideveloper/shared';
import { builtInConnectors, pubmed } from './connectors.js';
import type { ConnectorContext, ConnectorResponse } from './connectorSupport.js';
import { createElnBenchling, elnBenchling } from './elnBenchling.js';
import { callExternalMcpTool, discoverExternalMcpTools } from './mcp-client.js';
import { SpillManager, type SpillOptions } from './spill.js';

type QueryOptions = Partial<SpillOptions> & { allowLive?: boolean };
export type ConnectorRegistryOptions = Partial<SpillOptions> & {
  initialExternalServers?: ExternalMcpServerConfig[];
  credentialResolver?: (connectorId: string) => string | null;
};

interface ExternalServer {
  config: ExternalMcpServerConfig;
  status: 'configured' | 'connected' | 'error';
  tools?: McpToolDescriptor[];
}

const builtInAliases = new Map([
  ['biorxiv', 'arxiv-biorxiv'],
  ['string', 'string-db'],
]);

export class ConnectorRegistry {
  private readonly connectors = new Map(builtInConnectors.map(connector => [connector.info.id, connector]));
  private readonly externalServers = new Map<string, ExternalServer>();
  private readonly spillOptions: SpillOptions;
  private readonly spillManager: SpillManager;
  private readonly credentialResolver?: ConnectorRegistryOptions['credentialResolver'];

  constructor(options: ConnectorRegistryOptions = {}, initialExternalServers = options.initialExternalServers ?? []) {
    this.connectors.set(elnBenchling.info.id, createElnBenchling());
    this.credentialResolver = options.credentialResolver;
    this.spillOptions = {
      spillDir: options.spillDir ?? join(process.cwd(), 'spills'), maxBytes: options.maxBytes, maxLines: options.maxLines,
    };
    this.spillManager = new SpillManager(this.spillOptions);
    for (const config of initialExternalServers) this.registerExternalServer(config);
  }

  listConnectors(): ConnectorInfo[] {
    const builtIns = builtInConnectors.map(({ info }) => ({
      ...info, operations: [...info.operations],
      ...(info.supportsCredential && { hasCredential: Boolean(this.credentialResolver?.(info.id)) }),
    }));
    const external = [...this.externalServers.values()].map(({ config, status, tools }): ConnectorInfo => ({
      id: config.id,
      name: config.name,
      category: 'external-mcp',
      description: `External MCP server (${config.transport}, ${config.enabled ? 'enabled' : 'disabled'})`,
      operations: tools?.map(tool => tool.name) ?? [],
      status,
      ...(config.url !== undefined && { endpoint: config.url }),
      ...(tools !== undefined && { discoveredTools: structuredClone(tools) }),
      ...(config.transport === 'http' && {
        supportsCredential: true, credentialLabel: 'MCP Server Auth Token',
        hasCredential: Boolean(this.credentialResolver?.(config.id)),
      }),
    }));
    return [...builtIns, ...external];
  }

  private context(info: ConnectorInfo, options?: QueryOptions): ConnectorContext {
    return {
      allowLive: options?.allowLive,
      credential: options?.allowLive && info.supportsCredential
        ? this.credentialResolver?.(info.id) || undefined : undefined,
    };
  }

  private externalCredential(config: ExternalMcpServerConfig): string | undefined {
    if (config.transport !== 'http' || new Headers(config.headers).has('Authorization')) return undefined;
    return this.credentialResolver?.(config.id) || undefined;
  }

  registerExternalServer(config: ExternalMcpServerConfig): ExternalMcpServerConfig {
    if (!config.id.trim()) throw new Error('External MCP server ID is required');
    if (this.connectors.has(config.id)) throw new Error(`Connector "${config.id}" is built in`);
    this.externalServers.set(config.id, { config: structuredClone(config), status: 'configured' });
    return structuredClone(config);
  }

  removeExternalServer(id: string): boolean {
    return this.externalServers.delete(id);
  }

  listExternalServers(): ExternalMcpServerConfig[] {
    return [...this.externalServers.values()].map(({ config }) => structuredClone(config));
  }

  async discoverExternalTools(serverId: string): Promise<McpToolDescriptor[]> {
    const server = this.externalServers.get(serverId);
    if (!server) throw new Error(`Unknown external MCP server "${serverId}"`);
    if (!server.config.enabled) throw new Error(`External MCP server "${serverId}" is disabled`);
    try {
      const tools = await discoverExternalMcpTools(server.config, this.externalCredential(server.config));
      server.tools = tools;
      server.status = 'connected';
      return structuredClone(tools);
    } catch (error) {
      server.status = 'error';
      throw error;
    }
  }

  async query(
    connectorId: string, operation: string, params: Record<string, unknown>, options?: QueryOptions,
  ): Promise<ConnectorQueryResult> {
    const alias = this.externalServers.has(connectorId) ? undefined : builtInAliases.get(connectorId);
    const connector = this.connectors.get(alias ?? connectorId);
    let response: ConnectorResponse;
    if (connector) {
      response = await connector.execute(operation, params, this.context(connector.info, options));
    } else {
      const server = this.externalServers.get(connectorId);
      if (!server) throw new Error(`Unknown connector "${connectorId}"`);
      if (!server.config.enabled) throw new Error(`External MCP server "${connectorId}" is disabled`);
      const data = await callExternalMcpTool(server.config, operation, params, this.externalCredential(server.config));
      response = {
        data, format: typeof data === 'string' ? 'txt' : 'json', source: 'live',
        summary: `External MCP tool ${operation} on ${server.config.name}`,
      };
    }
    const { data, format, source, summary } = response;
    const spillManager = options?.spillDir !== undefined || options?.maxBytes !== undefined || options?.maxLines !== undefined
      ? new SpillManager({
        spillDir: options.spillDir ?? this.spillOptions.spillDir,
        maxBytes: options.maxBytes ?? this.spillOptions.maxBytes,
        maxLines: options.maxLines ?? this.spillOptions.maxLines,
      })
      : this.spillManager;
    return {
      connectorId, operation, source, summary, fetchedAt: new Date().toISOString(),
      ...spillManager.maybeSpill(data, format, `${connectorId}/${operation}`),
    };
  }

  async verifyCitation(identifier: string, options?: { allowLive?: boolean }): Promise<{
    identifier: string; verified: boolean; title?: string; source?: string;
  }> {
    if (!identifier.trim()) return { identifier, verified: false };
    const { data, source } = await pubmed.execute('verify_pmid', { identifier }, this.context(pubmed.info, options));
    const verification = data as { verified: boolean; title?: string };
    return {
      identifier, verified: verification.verified, source,
      ...(verification.title !== undefined && { title: verification.title }),
    };
  }
}
