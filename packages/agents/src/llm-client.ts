import { randomUUID } from 'node:crypto';
import type {
  DiscoveredModelInfo, LlmProtocolKind, LlmProviderKind, LlmProviderPreset, LlmSettings,
  ModelConnectionTestResult, SafeLlmSettings,
} from '@scideveloper/shared';
import { defaultLlmProvider, getProviderPreset, LLM_PROVIDER_IDS } from './providers.js';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: Array<{ mimeType: string; base64: string }> }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string; isError?: boolean };

export interface ToolCompletion {
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}

type OnDelta = (chunk: string) => void;
export type ModelRole = 'coordinator' | 'subagent' | 'reviewer' | 'compaction';

export interface CompletionOptions {
  role?: ModelRole;
  onDelta?: OnDelta;
  onThinkingDelta?: OnDelta;
  onUsage?: (usage: NonNullable<ToolCompletion['usage']>) => void;
  signal?: AbortSignal;
  throwOnError?: boolean;
}

export interface LlmKeyStore {
  getProviderKey(provider: LlmProviderKind): string | null | undefined;
  setProviderKey(provider: LlmProviderKind, key: string | undefined): void;
  listConfiguredVaultProviders(): readonly LlmProviderKind[];
}

export interface ModelDiscoveryInput {
  provider: LlmProviderKind;
  baseUrl?: string;
  apiKey?: string;
}

export interface ModelConnectionInput extends ModelDiscoveryInput {
  model: string;
}

interface ResolvedModel {
  preset: LlmProviderPreset;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

interface FunctionMessage {
  content?: string | null;
  thinking?: string;
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: unknown[];
  tool_calls?: Array<{
    id?: string;
    index?: number;
    function?: { name?: string; arguments?: unknown; index?: number };
  }>;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
}

interface InteractionsContentItem {
  type?: string;
  text?: string;
  thought?: string;
  summary?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  arguments_delta?: string;
}

interface InteractionsStep {
  type?: string;
  step_type?: string;
  content?: InteractionsContentItem[];
}

interface ProviderFrame {
  type?: string;
  event_type?: string;
  error?: unknown;
  choices?: Array<{ message?: FunctionMessage; delta?: FunctionMessage }>;
  message?: FunctionMessage & { usage?: Record<string, unknown> };
  content?: AnthropicBlock[];
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  index?: number;
  content_block?: AnthropicBlock;
  delta?: {
    type?: string;
    text?: string;
    thought?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: unknown;
    arguments_delta?: string;
  };
  outputs?: InteractionsContentItem[];
  steps?: InteractionsStep[];
  output_text?: string;
  interaction?: {
    outputs?: InteractionsContentItem[];
    steps?: InteractionsStep[];
    usage?: Record<string, unknown>;
  };
  usage?: Record<string, unknown>;
  usageMetadata?: Record<string, unknown>;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface NativeTurn {
  anthropic?: AnthropicBlock[];
  gemini?: GeminiPart[];
  geminiCallIds?: Set<string>;
  openai?: Pick<FunctionMessage, 'reasoning_content' | 'reasoning_details'>;
}

// Provider signatures and tool-call reasoning are only needed within the live turn.
const nativeTurns = new WeakMap<ToolCall[], NativeTurn>();

function anthropicMessages(messages: ChatMessage[]) {
  const turns: Array<{ role: 'assistant' | 'user'; content: unknown[] }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'tool' ? 'user' : message.role;
    const blocks: unknown[] = [];
    if (message.role === 'tool') {
      blocks.push({
        type: 'tool_result', tool_use_id: message.toolCallId, content: message.content,
        ...(message.isError && { is_error: true }),
      });
    } else {
      const original = message.role === 'assistant' && message.toolCalls &&
        nativeTurns.get(message.toolCalls)?.anthropic;
      if (original) {
        blocks.push(...original);
      } else {
        if (message.content) blocks.push({ type: 'text', text: message.content });
        if (message.role === 'user') {
          for (const { mimeType, base64 } of message.images ?? []) {
            blocks.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } });
          }
        } else {
          for (const call of message.toolCalls ?? []) {
            blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
          }
        }
      }
    }
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else if (blocks.length) turns.push({ role, content: blocks });
  }
  return turns;
}

function geminiContents(messages: ChatMessage[]) {
  const contents: Array<{ role: 'model' | 'user'; parts: unknown[] }> = [];
  const nativeIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: unknown[] = [];
    if (message.role === 'tool') {
      parts.push({ functionResponse: {
        ...(nativeIds.has(message.toolCallId) && { id: message.toolCallId }),
        name: message.name, response: message.isError ? { error: message.content } : { output: message.content },
      } });
    } else {
      const original = message.role === 'assistant' && message.toolCalls && nativeTurns.get(message.toolCalls);
      if (original && original.gemini) {
        for (const id of original.geminiCallIds ?? []) nativeIds.add(id);
        parts.push(...original.gemini);
      } else {
        if (message.content) parts.push({ text: message.content });
        if (message.role === 'user') {
          for (const { mimeType, base64 } of message.images ?? []) {
            parts.push({ inlineData: { mimeType, data: base64 } });
          }
        } else {
          for (const call of message.toolCalls ?? []) {
            parts.push({ functionCall: { name: call.name, args: call.arguments } });
          }
        }
      }
    }
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

function geminiInteractionsInput(messages: ChatMessage[]): string | Array<{ role: 'user' | 'model'; content: unknown }> {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  if (nonSystem.length === 1 && nonSystem[0].role === 'user' && !nonSystem[0].images?.length) {
    return nonSystem[0].content;
  }
  const turns: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];
  for (const message of nonSystem) {
    const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user';
    const parts: unknown[] = [];
    if (message.role === 'tool') {
      parts.push({
        type: 'function_result',
        call_id: message.toolCallId,
        name: message.name,
        result: message.isError ? { error: message.content } : { output: message.content },
      });
    } else if (message.role === 'user') {
      if (message.content) parts.push({ type: 'text', text: message.content });
      for (const { mimeType, base64 } of message.images ?? []) {
        parts.push({ type: 'image', mime_type: mimeType, data: base64 });
      }
    } else {
      if (message.content) parts.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ type: 'function_call', id: call.id, name: call.name, arguments: call.arguments });
      }
    }
    if (!parts.length) continue;
    const last = turns.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else turns.push({ role, parts });
  }
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.parts.length === 1 && record(turn.parts[0])?.type === 'text'
      ? String(record(turn.parts[0])?.text ?? '')
      : turn.parts,
  }));
}

function functionMessages(messages: ChatMessage[], preset: LlmProviderPreset) {
  const ollama = preset.protocol === 'ollama';
  return messages.map((message) => {
    const { role, content } = message;
    if (role === 'tool') return ollama
      ? { role, content, tool_name: message.name }
      : { role, content, tool_call_id: message.toolCallId };
    if (role === 'user' && message.images?.length) {
      return ollama
        ? { role, content, images: message.images.map(({ base64 }) => base64) }
        : { role, content: [
          { type: 'text', text: content },
          ...message.images.map(({ mimeType, base64 }) => ({
            type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64 },
          })),
        ] };
    }
    if (role !== 'assistant' || !message.toolCalls?.length) return { role, content };
    const native = nativeTurns.get(message.toolCalls)?.openai;
    return {
      role,
      content,
      ...(preset.id === 'deepseek' && native?.reasoning_content && { reasoning_content: native.reasoning_content }),
      ...(preset.id === 'openrouter' && native?.reasoning_details && { reasoning_details: native.reasoning_details }),
      tool_calls: message.toolCalls.map((call, index) => ({
        type: 'function',
        ...(!ollama && { id: call.id }),
        function: {
          name: call.name,
          arguments: ollama ? call.arguments : JSON.stringify(call.arguments),
          ...(ollama && { index }),
        },
      })),
    };
  });
}

// Fetch may split a line or UTF-8 character across arbitrary chunks.
async function* responseLines(body: NonNullable<Response['body']>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      yield* lines;
      if (done) break;
    }
    if (pending) yield pending;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* responseFrames(response: Response, protocol: LlmProtocolKind, streaming: boolean) {
  const mediaType = response.headers.get('content-type') ?? '';
  if (!response.body || !streaming || (mediaType.includes('application/json') && protocol !== 'ollama')) {
    const value = await response.json() as ProviderFrame | ProviderFrame[];
    yield* Array.isArray(value) ? value : [value];
    return;
  }
  for await (const line of responseLines(response.body)) {
    const trimmed = line.trim();
    const frame = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed.startsWith('{') ? trimmed : '';
    if (frame === '[DONE]') break;
    if (frame) yield JSON.parse(frame) as ProviderFrame;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseArguments(value: unknown): Record<string, unknown> {
  const args = record(typeof value === 'string' ? JSON.parse(value || '{}') : value ?? {});
  if (!args) throw new Error('Expected a tool argument object');
  return args;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

type ProviderUsage = Partial<NonNullable<ToolCompletion['usage']>>;

function usageFromFrame(frame: ProviderFrame, protocol: LlmProtocolKind): ProviderUsage {
  if (protocol === 'ollama') return { inputTokens: frame.prompt_eval_count, outputTokens: frame.eval_count };
  if (protocol === 'gemini') {
    const usage = frame.usageMetadata;
    if (usage) {
      const outputTokens = count(usage.candidatesTokenCount);
      const thinkingTokens = count(usage.thoughtsTokenCount);
      return {
        inputTokens: count(usage.promptTokenCount), cachedTokens: count(usage.cachedContentTokenCount),
        outputTokens: outputTokens !== undefined || thinkingTokens !== undefined
          ? (outputTokens ?? 0) + (thinkingTokens ?? 0) : undefined,
      };
    }
    const iUsage = frame.usage ?? frame.interaction?.usage;
    if (iUsage) {
      const out = count(iUsage.total_output_tokens ?? iUsage.output_tokens);
      const thought = count(iUsage.total_thought_tokens ?? iUsage.thought_tokens);
      return {
        inputTokens: count(iUsage.total_input_tokens ?? iUsage.input_tokens),
        cachedTokens: count(iUsage.total_cached_tokens ?? iUsage.cached_tokens),
        outputTokens: out !== undefined || thought !== undefined ? (out ?? 0) + (thought ?? 0) : undefined,
      };
    }
    return {};
  }
  const usage = frame.usage ?? frame.message?.usage;
  if (protocol === 'anthropic') return {
    inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens),
    cachedTokens: count(usage?.cache_read_input_tokens),
  };
  return {
    inputTokens: count(usage?.prompt_tokens), outputTokens: count(usage?.completion_tokens),
    cachedTokens: count(record(usage?.prompt_tokens_details)?.cached_tokens ?? usage?.prompt_cache_hit_tokens),
  };
}

async function readCompletion(
  response: Response, preset: LlmProviderPreset, streaming: boolean, options: CompletionOptions, geminiInteractions = false,
): Promise<ToolCompletion | null> {
  const { protocol } = preset;
  let text = '';
  let thinking = '';
  let usage: ProviderUsage = {};
  const calls = new Map<number, { id?: string; name: string; input?: unknown; fragments: string }>();
  const blocks = new Map<number, AnthropicBlock>();
  const gemini: GeminiPart[] = [];
  const geminiCallIds = new Set<string>();
  const reasoningDetails: unknown[] = [];
  let sawInteractionsDelta = false;
  const appendText = (delta?: string | null) => {
    if (!delta) return;
    text += delta;
    options.onDelta?.(delta);
  };
  const appendThinking = (delta?: string) => {
    if (!delta) return;
    thinking += delta;
    options.onThinkingDelta?.(delta);
  };
  const acceptBlock = (block: AnthropicBlock, index: number) => {
    blocks.set(index, { ...block });
    if (block.type === 'text') appendText(block.text);
    if (block.type === 'thinking') appendThinking(block.thinking);
    if (block.type === 'tool_use' && block.name) {
      calls.set(index, { id: block.id, name: block.name, input: block.input, fragments: '' });
    }
  };
  const acceptInteractionItems = (items: InteractionsContentItem[]) => {
    for (const item of items) {
      if (item.type === 'text' && item.text) appendText(item.text);
      else if (item.type === 'thought') appendThinking(item.thought ?? item.text ?? item.summary);
      else if ((item.type === 'function_call' || item.type === 'tool_call') && item.name) {
        calls.set(calls.size, {
          id: item.id ?? item.call_id,
          name: item.name,
          input: item.arguments,
          fragments: '',
        });
      }
    }
  };

  for await (const frame of responseFrames(response, protocol, streaming)) {
    if (frame.error || frame.type === 'error') {
      const errObj = record(frame.error);
      const detail = typeof errObj?.message === 'string' ? errObj.message
        : typeof frame.error === 'string' ? frame.error : '';
      throw new ProviderRequestError(detail || 'The provider reported an error while generating its response.');
    }
    usage = { ...usage, ...Object.fromEntries(Object.entries(usageFromFrame(frame, protocol)).filter(([, value]) => value !== undefined)) };
    if (protocol === 'anthropic') {
      frame.content?.forEach(acceptBlock);
      const index = frame.index ?? 0;
      if (frame.content_block) acceptBlock(frame.content_block, index);
      const block = blocks.get(index);
      if (frame.delta?.text) {
        appendText(frame.delta.text);
        if (block) block.text = (block.text ?? '') + frame.delta.text;
      }
      if (frame.delta?.thinking) {
        appendThinking(frame.delta.thinking);
        if (block) block.thinking = (block.thinking ?? '') + frame.delta.thinking;
      }
      if (block && frame.delta?.signature) block.signature = (block.signature ?? '') + frame.delta.signature;
      const call = calls.get(index);
      if (call && frame.delta?.partial_json) call.fragments += frame.delta.partial_json;
    } else if (protocol === 'gemini' && geminiInteractions) {
      if (frame.delta) {
        const d = frame.delta;
        if (d.type === 'thought' || d.thought) {
          sawInteractionsDelta = true;
          appendThinking(d.thought ?? d.text);
        } else if (d.type === 'function_call' || d.type === 'tool_call') {
          sawInteractionsDelta = true;
          const key = frame.index ?? calls.size;
          const existing = calls.get(key) ?? { name: '', fragments: '' };
          if (d.id ?? d.call_id) existing.id = d.id ?? d.call_id;
          if (d.name) existing.name += d.name;
          if (typeof d.arguments_delta === 'string') existing.fragments += d.arguments_delta;
          else if (typeof d.arguments === 'string') existing.fragments += d.arguments;
          else if (d.arguments !== undefined) existing.input = d.arguments;
          calls.set(key, existing);
        } else if (d.text) {
          sawInteractionsDelta = true;
          appendText(d.text);
        }
      } else {
        const outputs = frame.outputs ?? frame.interaction?.outputs;
        const steps = frame.steps ?? frame.interaction?.steps;
        if (!sawInteractionsDelta) {
          if (Array.isArray(outputs) && outputs.length > 0) {
            acceptInteractionItems(outputs);
          } else if (Array.isArray(steps) && steps.length > 0) {
            for (const step of steps) {
              if (step.type === 'user_input' || step.step_type === 'user_input') continue;
              if (Array.isArray(step.content)) acceptInteractionItems(step.content);
            }
          } else if (typeof frame.output_text === 'string' && frame.output_text) {
            appendText(frame.output_text);
          }
        }
      }
    } else if (protocol === 'gemini') {
      for (const part of frame.candidates?.[0]?.content?.parts ?? []) {
        gemini.push(part);
        if (part.thought) appendThinking(part.text);
        else appendText(part.text);
        if (!part.functionCall) continue;
        const { id, name, args } = part.functionCall;
        if (id) geminiCallIds.add(id);
        calls.set(calls.size, { id, name, input: args, fragments: '' });
      }
    } else {
      const choice = frame.choices?.[0];
      const message = protocol === 'ollama' ? frame.message : choice?.delta ?? choice?.message;
      appendText(message?.content);
      appendThinking(message?.thinking ?? message?.reasoning_content ?? message?.reasoning);
      if (message?.reasoning_details) reasoningDetails.push(...message.reasoning_details);
      message?.tool_calls?.forEach((item, index) => {
        const key = protocol === 'ollama' ? calls.size : item.index ?? item.function?.index ?? index;
        const call = calls.get(key) ?? { name: '', fragments: '' };
        if (item.id) call.id = item.id;
        if (item.function?.name) call.name += item.function.name;
        const args = item.function?.arguments;
        if (typeof args === 'string') call.fragments += args;
        else if (args !== undefined) call.input = args;
        calls.set(key, call);
      });
    }
  }
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
    if (!call.name) throw new Error('Missing tool name');
    const args = parseArguments(call.fragments || call.input);
    const block = blocks.get(index);
    if (block?.type === 'tool_use') block.input = args;
    return { id: call.id ?? 'call_' + randomUUID(), name: call.name, arguments: args };
  });
  if (toolCalls.length) {
    const anthropic = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
    nativeTurns.set(toolCalls, {
      ...(anthropic.some((block) => block.signature || block.type === 'redacted_thinking') && { anthropic }),
      ...(gemini.length > 0 && { gemini, geminiCallIds }),
      ...(protocol === 'openai' && { openai: {
        ...(thinking && { reasoning_content: thinking }),
        ...(reasoningDetails.length > 0 && { reasoning_details: reasoningDetails }),
      } }),
    });
  }
  const totals = Object.keys(usage).length > 0 ? { inputTokens: 0, outputTokens: 0, ...usage } : undefined;
  if (totals) options.onUsage?.(totals);
  return text.trim() || toolCalls.length || thinking
    ? { text: text.trim(), ...(thinking && { thinking }), toolCalls, ...(totals && { usage: totals }) }
    : null;
}

function authHeaders({ preset, apiKey }: ResolvedModel): Record<string, string> {
  if (preset.protocol === 'anthropic') return { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' };
  if (preset.protocol === 'gemini') return { 'x-goog-api-key': apiKey ?? '' };
  return apiKey ? {
    Authorization: 'Bearer ' + apiKey, ...(preset.id === 'azure-openai' && { 'api-key': apiKey }),
  } : {};
}

function protocolPath(baseUrl: string, version: string, resource: string): string {
  if (baseUrl.endsWith(resource)) return baseUrl;
  return baseUrl + (baseUrl.endsWith(version) ? '' : version) + resource;
}

function normalizeGeminiRoot(baseUrl: string): string {
  return baseUrl
    .replace(/\/interactions(?:\/[^/?#]+)?$/i, '')
    .replace(/\/models(?:\/[^?#]+)?$/i, '')
    .replace(/\/+$/, '');
}

function shouldUseGeminiInteractions(baseUrl: string, model: string): boolean {
  if (/\/interactions(?:\/[^/?#]+)?$/i.test(baseUrl)) return true;
  if (/\/models\/[^/?#]+:(?:stream)?generateContent/i.test(baseUrl)) return false;
  return /^gemini-4(?:[-.]|$)/i.test(model);
}

async function readUpstreamErrorDetail(response: Response): Promise<string> {
  try {
    const raw = (await response.text()).trim();
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const nested = record(parsed.error);
      const msg = nested?.message ?? parsed.message ?? parsed.detail ?? parsed.error;
      if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 260);
    } catch {
      // plain text body
    }
    return raw.replace(/\s+/g, ' ').slice(0, 220);
  } catch {
    return '';
  }
}

class ProviderRequestError extends Error {}

function completionOptions(
  onDeltaOrOptions?: OnDelta | CompletionOptions, signalOrOptions?: AbortSignal | CompletionOptions, options?: CompletionOptions,
): CompletionOptions {
  return {
    ...(typeof onDeltaOrOptions === 'function' ? { onDelta: onDeltaOrOptions } : onDeltaOrOptions),
    ...(signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : signalOrOptions),
    ...options,
  };
}

export class LlmClient {
  private settings: LlmSettings;
  private readonly keys = new Map<LlmProviderKind, string>();

  constructor(
    initial?: Partial<LlmSettings>,
    private readonly persistSettings?: (settings: LlmSettings) => void,
    private readonly vaultProtection?: Exclude<NonNullable<SafeLlmSettings['keyProtection']>, 'none'>,
    private readonly keyStore?: LlmKeyStore,
  ) {
    const { apiKey, apiKeyProvider, ...settings } = initial ?? {};
    const provider = settings.provider && LLM_PROVIDER_IDS.includes(settings.provider) ? settings.provider : defaultLlmProvider();
    this.settings = {
      ...settings, provider,
      model: settings.model || settings.providerModels?.[provider] || process.env.SCIDEV_LLM_MODEL || getProviderPreset(provider).defaultModel,
      baseUrl: settings.baseUrl || settings.providerBaseUrls?.[provider] || process.env.SCIDEV_LLM_BASE_URL,
      temperature: settings.temperature ?? 0.2,
    };
    if (apiKey) this.saveKey(apiKeyProvider ?? provider, apiKey);
  }

  private getKey(provider: LlmProviderKind): string | undefined {
    const { envKeyName } = getProviderPreset(provider);
    return this.keyStore?.getProviderKey(provider)?.trim() || this.keys.get(provider) ||
      (envKeyName && process.env[envKeyName]?.trim()) || undefined;
  }

  private saveKey(provider: LlmProviderKind, apiKey: string): void {
    const key = apiKey.trim() || undefined;
    if (this.keyStore) this.keyStore.setProviderKey(provider, key);
    else if (key) this.keys.set(provider, key);
    else this.keys.delete(provider);
  }

  getSafeSettings(): SafeLlmSettings {
    const settings = this.settings;
    const { provider, model, baseUrl, temperature, pythonExecutable, routing, providerBaseUrls, providerModels } = settings;
    const vaultProviders = this.keyStore?.listConfiguredVaultProviders() ?? [];
    const configuredProviders = LLM_PROVIDER_IDS.filter((id) => {
      const { envKeyName } = getProviderPreset(id);
      return vaultProviders.includes(id) || this.keys.has(id) || Boolean(envKeyName && process.env[envKeyName]?.trim());
    });
    return {
      provider, model, baseUrl, temperature, pythonExecutable, routing: structuredClone(routing ?? {}),
      providerBaseUrls: { ...providerBaseUrls }, providerModels: { ...providerModels },
      hasApiKey: configuredProviders.includes(provider), configuredProviders,
      keyProtection: vaultProviders.length ? this.vaultProtection ?? 'none' : 'none',
      enableThinking: settings.enableThinking ?? false, thinkingBudgetTokens: settings.thinkingBudgetTokens ?? 4_096,
      allowLiveConnectors: settings.allowLiveConnectors ?? false, maxAgentIterations: settings.maxAgentIterations ?? 6,
      enableVisionAudit: settings.enableVisionAudit ?? true, memoryLimitMb: settings.memoryLimitMb ?? 4_096,
      language: settings.language ?? 'en', isConfigured: this.isLiveProviderConfigured(),
    };
  }

  updateSettings(patch: Partial<LlmSettings>): SafeLlmSettings {
    const { apiKey, apiKeyProvider, ...fields } = patch;
    const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const current = this.settings;
    const next: LlmSettings = { ...current, ...changes };
    for (const field of ['maxAgentIterations', 'thinkingBudgetTokens', 'memoryLimitMb'] as const) {
      const value = next[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new RangeError(field + ' must be a positive integer');
      }
    }
    const { provider } = next;
    const preset = getProviderPreset(provider);
    next.providerModels = { ...current.providerModels, [current.provider]: current.model, ...patch.providerModels };
    next.providerBaseUrls = {
      ...current.providerBaseUrls, ...(current.baseUrl !== undefined && { [current.provider]: current.baseUrl }),
      ...patch.providerBaseUrls,
    };
    next.model = patch.model ?? next.providerModels[provider] ?? preset.defaultModel;
    next.baseUrl = patch.baseUrl ?? next.providerBaseUrls[provider];
    next.providerModels[provider] = next.model;
    if (next.baseUrl !== undefined) next.providerBaseUrls[provider] = next.baseUrl;
    if (apiKey !== undefined) this.saveKey(apiKeyProvider ?? provider, apiKey);
    this.persistSettings?.(next);
    this.settings = next;
    return this.getSafeSettings();
  }

  private resolveModel(role: ModelRole = 'coordinator', input?: ModelDiscoveryInput & { model?: string }): ResolvedModel {
    const active = this.settings;
    const route = role === 'coordinator' ? undefined : active.routing?.[role];
    const provider = input?.provider ?? route?.provider ?? active.provider;
    const preset = getProviderPreset(provider);
    const configuredBaseUrl = input?.baseUrl ?? route?.baseUrl ??
      (provider === active.provider ? active.baseUrl : active.providerBaseUrls?.[provider]);
    return {
      preset,
      model: input?.model || route?.model || (provider === active.provider ? active.model : active.providerModels?.[provider]) || preset.defaultModel,
      baseUrl: (configuredBaseUrl?.trim() || preset.defaultBaseUrl).replace(/\/+$/, ''),
      apiKey: input?.apiKey?.trim() || this.getKey(provider),
    };
  }

  isLiveProviderConfigured(role?: ModelRole): boolean {
    const { preset, apiKey } = this.resolveModel(role);
    return !preset.requiresApiKey || Boolean(apiKey);
  }

  supportsVision(role?: ModelRole): boolean {
    return this.resolveModel(role).preset.supportsVision;
  }

  async complete(
    messages: ChatMessage[], maxTokens: number | CompletionOptions = 1400,
    onDelta?: OnDelta | CompletionOptions, signal?: AbortSignal | CompletionOptions, options?: CompletionOptions,
  ): Promise<string | null> {
    return (await this.completeWithTools(messages, [], maxTokens, onDelta, signal, options))?.text || null;
  }

  async completeWithTools(
    messages: ChatMessage[], tools: ToolDefinition[], maxTokens: number | CompletionOptions = 1400,
    onDelta?: OnDelta | CompletionOptions, signal?: AbortSignal | CompletionOptions, options?: CompletionOptions,
  ): Promise<ToolCompletion | null> {
    const merged = completionOptions(onDelta, signal, options);
    const resolved = typeof maxTokens === 'number' ? merged : { ...maxTokens, ...merged };
    const config = this.resolveModel(resolved.role);
    try {
      return await this.requestCompletion(config, messages, tools, typeof maxTokens === 'number' ? maxTokens : 1400, resolved);
    } catch (error) {
      if (resolved.signal?.aborted) throw new DOMException('The research run was cancelled', 'AbortError');
      if (resolved.throwOnError) throw error;
      return null;
    }
  }

  private async requestCompletion(
    config: ResolvedModel, messages: ChatMessage[], tools: ToolDefinition[], maxTokens: number,
    options: CompletionOptions, ping = false,
  ): Promise<ToolCompletion | null> {
    const { preset, model, baseUrl, apiKey } = config;
    const { protocol } = preset;
    const { signal } = options;
    if (signal?.aborted) throw new DOMException('The research run was cancelled', 'AbortError');
    if (preset.requiresApiKey && !apiKey) throw new ProviderRequestError('An API key is required for ' + preset.name + '.');
    const { temperature, enableThinking, thinkingBudgetTokens } = this.getSafeSettings();
    const thinking = !ping && enableThinking && preset.supportsThinking;
    const stream = Boolean(options.onDelta || options.onThinkingDelta);
    const headers = { 'Content-Type': 'application/json', ...authHeaders(config) };
    const system = messages.filter((message) => message.role === 'system').map(({ content }) => content).join('\n\n');
    let url: string;
    let body: Record<string, unknown>;
    let geminiInteractions = false;
    if (protocol === 'anthropic') {
      url = protocolPath(baseUrl, '/v1', '/messages');
      const budget = Math.max(1024, thinkingBudgetTokens);
      body = {
        model, stream, system, messages: anthropicMessages(messages),
        ...(thinking ? { thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: maxTokens + budget }
          : { temperature, max_tokens: maxTokens }),
        ...(tools.length && { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })) }),
      };
    } else if (protocol === 'gemini') {
      geminiInteractions = shouldUseGeminiInteractions(baseUrl, model);
      if (geminiInteractions) {
        const root = normalizeGeminiRoot(baseUrl);
        url = /\/interactions$/i.test(baseUrl) ? baseUrl : root + '/interactions';
        const thinkingLevel = ping ? 'low' : thinking ? (thinkingBudgetTokens >= 8192 ? 'high' : 'medium') : 'low';
        body = {
          model,
          ...(system && { system_instruction: system }),
          input: geminiInteractionsInput(messages),
          ...(stream && { stream: true }),
          store: false,
          generation_config: {
            temperature,
            max_output_tokens: (ping ? Math.max(64, maxTokens) : maxTokens) + (thinking ? thinkingBudgetTokens : 0),
            thinking_level: thinkingLevel,
          },
          ...(tools.length && {
            tools: tools.map(({ name, description, inputSchema }) => ({
              type: 'function', name, description, parameters: inputSchema,
            })),
          }),
        };
      } else {
        const root = normalizeGeminiRoot(baseUrl);
        url = root + '/models/' + encodeURIComponent(model) + ':' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent');
        body = {
          ...(system && { systemInstruction: { parts: [{ text: system }] } }),
          contents: geminiContents(messages),
          generationConfig: {
            temperature, maxOutputTokens: (ping ? Math.max(64, maxTokens) : maxTokens) + (thinking ? thinkingBudgetTokens : 0),
            ...(thinking && { thinkingConfig: { includeThoughts: true, thinkingBudget: thinkingBudgetTokens } }),
          },
          ...(tools.length && { tools: [{ functionDeclarations: tools.map(({ name, description, inputSchema }) => ({
            name, description, parametersJsonSchema: inputSchema,
          })) }] }),
        };
      }
    } else {
      const ollama = protocol === 'ollama';
      url = ollama
        ? protocolPath(baseUrl, '/api', '/chat')
        : /\/chat\/completions$/i.test(baseUrl)
          ? baseUrl
          : baseUrl + '/chat/completions';
      const reasoningModel = (preset.id === 'openai' || preset.id === 'azure-openai') && /^(gpt-[56]|o[134])(?:[-.]|$)/i.test(model);
      const effectiveMaxTokens = ping && (reasoningModel || preset.id === 'deepseek') ? Math.max(64, maxTokens) : maxTokens;
      body = {
        model, stream, messages: functionMessages(messages, preset),
        ...(ollama ? { options: { temperature, num_predict: effectiveMaxTokens } }
          : reasoningModel ? { max_completion_tokens: effectiveMaxTokens } : { temperature, max_tokens: effectiveMaxTokens }),
        ...(ollama && thinking && { think: true }),
        ...(stream && ['openai', 'azure-openai', 'openrouter', 'deepseek'].includes(preset.id) &&
          { stream_options: { include_usage: true } }),
        ...(tools.length && { tools: tools.map(({ name, description, inputSchema }) => ({
          type: 'function', function: { name, description, parameters: inputSchema },
        })) }),
      };
    }

    const timeout = AbortSignal.timeout(ping ? 15_000 : 120_000);
    try {
      const response = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        redirect: 'error',
      });
      if (!response.ok) {
        const detail = await readUpstreamErrorDetail(response);
        throw new ProviderRequestError(
          preset.name + ' returned HTTP ' + response.status + (detail ? ': ' + detail : '.')
        );
      }
      const result = await readCompletion(response, preset, stream, options, geminiInteractions);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('The research run was cancelled', 'AbortError');
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(timeout.aborted ? preset.name + ' timed out.' : preset.name + ' could not return a valid response.');
    }
  }

  async testConnection(input: ModelConnectionInput): Promise<ModelConnectionTestResult> {
    const started = performance.now();
    const { model } = input;
    const result = () => ({ provider: input.provider, model, latencyMs: Math.round(performance.now() - started) });
    try {
      const completion = await this.requestCompletion(this.resolveModel('coordinator', input), [
        { role: 'user', content: 'Reply with OK' },
      ], [], 16, {}, true);
      const preview = completion?.text || (completion?.thinking ? `(Reasoning) ${completion.thinking}` : '');
      if (!preview) return { ...result(), ok: false, error: 'The provider returned an empty reply.' };
      return { ...result(), ok: true, replyPreview: preview.slice(0, 160) };
    } catch (error) {
      return { ...result(), ok: false, error: error instanceof ProviderRequestError ? error.message : 'Model connection failed.' };
    }
  }

  async discoverModels(input: ModelDiscoveryInput): Promise<DiscoveredModelInfo[]> {
    const config = this.resolveModel('coordinator', input);
    const { preset, baseUrl } = config;
    const fallback = () => preset.suggestedModels.map((id) => ({
      id, contextWindow: preset.contextWindowDefault, supportsVision: preset.supportsVision, supportsThinking: preset.supportsThinking,
    }));
    const url = preset.protocol === 'ollama'
      ? protocolPath(baseUrl.replace(/\/api\/chat$/i, ''), '/api', '/tags')
      : preset.protocol === 'anthropic'
        ? protocolPath(baseUrl.replace(/\/messages$/i, ''), '/v1', '/models')
        : preset.protocol === 'gemini'
          ? normalizeGeminiRoot(baseUrl) + '/models'
          : baseUrl.replace(/\/chat\/completions$/i, '') + '/models';
    try {
      const response = await fetch(url, { headers: authHeaders(config), signal: AbortSignal.timeout(8_000), redirect: 'error' });
      if (!response.ok) return fallback();
      const payload = await response.json() as { data?: unknown[]; models?: unknown[] };
      const models = (payload.data ?? payload.models ?? []).flatMap((entry) => {
        const item = record(entry);
        if (!item) return [];
        if (
          preset.protocol === 'gemini' &&
          Array.isArray(item.supportedGenerationMethods) &&
          !item.supportedGenerationMethods.includes('generateContent') &&
          !item.supportedGenerationMethods.includes('interactions')
        ) return [];
        const id = item.id ?? item.model ?? item.name;
        const name = item.displayName ?? item.display_name ?? item.name;
        return typeof id === 'string' && id ? [{
          id: preset.protocol === 'gemini' ? id.replace(/^models\//, '') : id,
          ...(typeof name === 'string' && name !== id && { name }),
          contextWindow: count(item.inputTokenLimit ?? item.context_length ?? item.context_window) ?? preset.contextWindowDefault,
          supportsVision: preset.supportsVision, supportsThinking: preset.supportsThinking,
        }] : [];
      });
      return models.length ? models : fallback();
    } catch {
      return fallback();
    }
  }
}
