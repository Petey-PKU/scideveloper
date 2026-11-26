import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmSettings } from '@scideveloper/shared';
import { LLM_PROVIDER_IDS, LLM_PROVIDER_PRESETS } from './providers.js';
import { LlmClient, type ChatMessage, type ToolDefinition } from './llm-client.js';

const tool: ToolDefinition = {
  name: 'read_workspace_file', description: 'Read a bounded preview',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const messages: ChatMessage[] = [
  { role: 'system', content: 'Use research tools.' },
  { role: 'user', content: 'Inspect this workspace dataset.' },
];

describe('native LLM tool protocols', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('streams Anthropic text and tool arguments, and batches the tool results into one user message', async () => {
    const deltas: string[] = [];
    const frames = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Inspecting the file.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: tool.name, input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"test.csv"}' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: tool.name, input: { path: 'test.tsv' } } },
      { type: 'message_stop' },
    ];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ))
      .mockResolvedValueOnce(Response.json({ content: [{ type: 'text', text: 'Complete.' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const llm = new LlmClient({ provider: 'anthropic', apiKey: 'test-key', model: 'claude-test' });
    const completion = await llm.completeWithTools(messages, [tool], 1000, (delta) => deltas.push(delta));
    expect(completion).toEqual({
      text: 'Inspecting the file.',
      toolCalls: [
        { id: 'toolu_1', name: tool.name, arguments: { path: 'test.csv' } },
        { id: 'toolu_2', name: tool.name, arguments: { path: 'test.tsv' } },
      ],
    });
    expect(deltas).toEqual(['Inspecting the file.']);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      system: 'Use research tools.', stream: true, max_tokens: 1000,
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }],
    });
    await expect(llm.completeWithTools([
      ...messages, { role: 'assistant', content: completion!.text, toolCalls: completion!.toolCalls },
      { role: 'tool', content: 'rows 4', toolCallId: 'toolu_1', name: tool.name },
      { role: 'tool', content: 'File missing', toolCallId: 'toolu_2', name: tool.name, isError: true },
    ], [tool])).resolves.toEqual({ text: 'Complete.', toolCalls: [] });
    const next = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(next.messages.slice(-2)).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'Inspecting the file.' },
        { type: 'tool_use', id: 'toolu_1', name: tool.name, input: { path: 'test.csv' } },
        { type: 'tool_use', id: 'toolu_2', name: tool.name, input: { path: 'test.tsv' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'rows 4' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'File missing', is_error: true },
      ] },
    ]);
  });

  it('uses Ollama NDJSON streams and sends tool results by name', async () => {
    const toolCall = { function: { name: tool.name, arguments: { path: 'study.csv' } } };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        [{ message: { content: 'Reading.' } }, { message: { tool_calls: [toolCall] }, done: true }]
          .map((chunk) => JSON.stringify(chunk)).join('\n'),
        { headers: { 'Content-Type': 'application/x-ndjson' } },
      ))
      .mockResolvedValueOnce(Response.json({ message: { content: 'Found the file.' }, done: true }));
    vi.stubGlobal('fetch', fetchMock);
    const llm = new LlmClient({ provider: 'ollama', model: 'test-local' });
    const delta = vi.fn();
    const completion = await llm.completeWithTools(messages, [tool], 800, delta);
    expect(completion).toMatchObject({ text: 'Reading.', toolCalls: [
      { id: expect.any(String), name: tool.name, arguments: { path: 'study.csv' } },
    ] });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/chat');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      stream: true, options: { num_predict: 800 },
      tools: [{ type: 'function', function: { name: tool.name, parameters: tool.inputSchema } }],
    });
    expect(delta).toHaveBeenCalledExactlyOnceWith('Reading.');
    await expect(llm.complete([
      ...messages, { role: 'assistant', content: completion!.text, toolCalls: completion!.toolCalls },
      { role: 'tool', content: 'four rows', toolCallId: completion!.toolCalls[0].id, name: tool.name },
    ])).resolves.toBe('Found the file.');
    const next = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(next.messages.at(-2).tool_calls).toEqual([{ type: 'function', function: { ...toolCall.function, index: 0 } }]);
    expect(next.messages.at(-1)).toEqual({ role: 'tool', tool_name: tool.name, content: 'four rows' });
  });
  const images = [{ mimeType: 'image/png', base64: 'aW1hZ2U=' }];
  const visionCases = [
    ['openai', { content: [{ type: 'text', text: 'Check the plot' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] }],
    ['anthropic', { content: [{ type: 'text', text: 'Check the plot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }] }],
    ['ollama', { content: 'Check the plot', images: ['aW1hZ2U='] }],
  ] as const satisfies ReadonlyArray<readonly [LlmSettings['provider'], object]>;

  it.each(visionCases)('serializes images for %s', async (provider, payload) => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response('', { status: 503 })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new LlmClient({ provider, apiKey: 'test-key' });
    await client.complete([{ role: 'user', content: 'Check the plot', images }]);
    const { messages: sent } = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent[0]).toEqual({ role: 'user', ...payload });
  });

  it('propagates a caller abort to fetch and rejects an already cancelled completion', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new LlmClient({ provider: 'ollama' });
    const completion = client.complete(messages, 800, undefined, controller.signal);
    controller.abort('stop');
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.completeWithTools(messages, [tool], 800, undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  const sse = (...frames: unknown[]) => new Response(
    frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );

  it('preserves Anthropic thinking signatures through tool use and reports streaming usage', async () => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        { type: 'message_start', message: { usage: { input_tokens: 81, cache_read_input_tokens: 20, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check the counts' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature-for-model' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'anthropic_call', name: tool.name, input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"input.csv"}' } },
        { type: 'message_delta', usage: { output_tokens: 12 } },
      ))
      .mockResolvedValueOnce(Response.json({ content: [{ type: 'text', text: 'Complete.' }] }));
    vi.stubGlobal('fetch', network);
    const client = new LlmClient({ provider: 'anthropic', apiKey: 'key', enableThinking: true, thinkingBudgetTokens: 1500 });
    const thought = vi.fn();
    const completion = await client.completeWithTools(messages, [tool], 2000, { onThinkingDelta: thought });
    expect(completion).toMatchObject({
      text: '', thinking: 'Check the counts',
      toolCalls: [{ id: 'anthropic_call', name: tool.name, arguments: { path: 'input.csv' } }],
      usage: { inputTokens: 81, outputTokens: 12, cachedTokens: 20 },
    });
    expect(thought).toHaveBeenCalledExactlyOnceWith('Check the counts');
    const body = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ stream: true, max_tokens: 3500, thinking: { type: 'enabled', budget_tokens: 1500 } });
    expect(body).not.toHaveProperty('temperature');
    await client.completeWithTools([...messages, { role: 'assistant', content: '', toolCalls: completion!.toolCalls },
      { role: 'tool', name: tool.name, toolCallId: 'anthropic_call', content: '10 rows' }], [tool]);
    const followup = JSON.parse(String(network.mock.calls[1][1]?.body));
    expect(followup.messages.at(-2).content[0]).toEqual({ type: 'thinking', thinking: 'Check the counts', signature: 'signature-for-model' });
  });

  it('sends native Gemini Vision and function declarations and retains signed tool parts', async () => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        { candidates: [{ content: { parts: [
          { thought: true, text: 'Inspect the axes' },
          { functionCall: { id: 'gemini_tool', name: tool.name, args: { path: 'plot.csv' } }, thoughtSignature: 'signed' },
        ] } }] },
        { candidates: [{ content: { parts: [{ text: 'Read complete.' }] } }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5, thoughtsTokenCount: 7, cachedContentTokenCount: 3 } },
      ))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
    vi.stubGlobal('fetch', network);
    const client = new LlmClient({ provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'gemini-key', enableThinking: true });
    const delta = vi.fn();
    const thought = vi.fn();
    const withImage: ChatMessage[] = [...messages, { role: 'user', content: 'Inspect the plot', images }];
    const result = await client.completeWithTools(withImage, [tool], 900, { onDelta: delta, onThinkingDelta: thought });
    expect(result).toMatchObject({
      text: 'Read complete.', thinking: 'Inspect the axes',
      toolCalls: [{ id: 'gemini_tool', name: tool.name, arguments: { path: 'plot.csv' } }],
      usage: { inputTokens: 40, outputTokens: 12, cachedTokens: 3 },
    });
    expect(delta).toHaveBeenCalledExactlyOnceWith('Read complete.');
    expect(thought).toHaveBeenCalledExactlyOnceWith('Inspect the axes');
    expect(network.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(network.mock.calls[0][1]?.headers).toMatchObject({ 'x-goog-api-key': 'gemini-key' });
    const first = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(first).toMatchObject({
      systemInstruction: { parts: [{ text: 'Use research tools.' }] },
      generationConfig: { thinkingConfig: { includeThoughts: true } },
      tools: [{ functionDeclarations: [{ name: tool.name, parametersJsonSchema: tool.inputSchema }] }],
    });
    expect(first.contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: images[0].base64 } });
    await expect(client.complete([...withImage, { role: 'assistant', content: result!.text, toolCalls: result!.toolCalls },
      { role: 'tool', name: tool.name, toolCallId: 'gemini_tool', content: 'File found' }])).resolves.toBe('OK');
    const next = JSON.parse(String(network.mock.calls[1][1]?.body));
    expect(next.contents.at(-2).parts).toContainEqual(expect.objectContaining({ thoughtSignature: 'signed' }));
    expect(next.contents.at(-1)).toMatchObject({ role: 'user', parts: [
      { functionResponse: { id: 'gemini_tool', name: tool.name, response: { output: 'File found' } } },
    ] });
  });

  it.each([
    ['deepseek', 'https://api.deepseek.com/v1', 'reasoning_content', 'reasoner-key'],
    ['openrouter', 'https://openrouter.ai/api/v1', 'reasoning', 'router-key'],
    ['openai-compatible', 'http://127.0.0.1:8000/v1', 'reasoning', ''],
  ] as const)('streams thinking and OpenAI-format usage for %s', async (provider, endpoint, reasoningField, apiKey) => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { choices: [{ delta: { [reasoningField]: 'Reasoning' } }] },
      { choices: [{ delta: { content: 'Answer' } }] },
      { choices: [], usage: { prompt_tokens: 18, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 4 } } },
    ));
    vi.stubGlobal('fetch', network);
    const client = new LlmClient({ provider, apiKey });
    const onDelta = vi.fn();
    const onThinkingDelta = vi.fn();
    await expect(client.completeWithTools(messages, [], { onDelta, onThinkingDelta })).resolves.toEqual({
      text: 'Answer', thinking: 'Reasoning', toolCalls: [],
      usage: { inputTokens: 18, outputTokens: 9, cachedTokens: 4 },
    });
    expect(network.mock.calls[0][0]).toBe(endpoint + '/chat/completions');
    expect(new Headers(network.mock.calls[0][1]?.headers).get('Authorization')).toBe(apiKey ? 'Bearer ' + apiKey : null);
    expect(onThinkingDelta).toHaveBeenCalledExactlyOnceWith('Reasoning');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('Answer');
  });

  it('routes an Azure role using its vault key, deployment, and base URL', async () => {
    const keys = new Map([['azure-openai', 'azure-vault-key']]);
    const client = new LlmClient({
      provider: 'openai', model: 'coordinator-model',
      routing: { subagent: { provider: 'azure-openai', model: 'science-deployment', baseUrl: 'https://custom.openai.azure.com/openai/v1/' } },
    }, undefined, 'aes-256-gcm-vault', {
      getProviderKey: (id) => keys.get(id),
      setProviderKey: (id, key) => { if (key) keys.set(id, key); else keys.delete(id); },
      listConfiguredVaultProviders: () => keys.has('azure-openai') ? ['azure-openai'] : [],
    });
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'Specialist' } }] }));
    vi.stubGlobal('fetch', network);
    expect(client.getSafeSettings().configuredProviders).toContain('azure-openai');
    await expect(client.complete(messages, 128, { role: 'subagent' })).resolves.toBe('Specialist');
    const [url, init] = network.mock.calls[0];
    expect(url).toBe('https://custom.openai.azure.com/openai/v1/chat/completions');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer azure-vault-key', 'api-key': 'azure-vault-key' });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'science-deployment', max_tokens: 128 });
  });

  it('tests a connection with a 16-token request and discovers models with a preset fallback', async () => {
    const client = new LlmClient({ provider: 'openai', apiKey: 'saved-key' });
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'OK' } }] }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ models: [
        { name: 'models/research', displayName: 'Research', inputTokenLimit: 32000, supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
      ] }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', network);
    await expect(client.testConnection({ provider: 'openai', model: 'gpt-4.1' })).resolves.toMatchObject({
      ok: true, latencyMs: expect.any(Number), replyPreview: 'OK',
    });
    expect(network.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer saved-key' });
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toMatchObject({ max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK' }] });
    await expect(client.testConnection({ provider: 'openai', model: 'invalid', apiKey: 'override' })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('HTTP 401'),
    });
    expect(network.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer override' });
    await expect(client.discoverModels({ provider: 'gemini', apiKey: 'test' })).resolves.toMatchObject([
      { id: 'research', name: 'Research', contextWindow: 32000 },
    ]);
    expect(network.mock.calls[2][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    await expect(client.discoverModels({ provider: 'ollama' })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'llama3.1' }),
    ]));
    expect(network.mock.calls[3][0]).toBe('http://127.0.0.1:11434/api/tags');
  });

  it('normalizes full endpoint URLs without duplicating paths and surfaces upstream HTTP error details', async () => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'OK' } }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Model not found: bad-model' } }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'GPT-6 OK' } }] }));
    vi.stubGlobal('fetch', network);
    const client = new LlmClient({ provider: 'deepseek', apiKey: 'ds-key', baseUrl: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' });

    await expect(client.testConnection({
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      apiKey: 'ds-key',
    })).resolves.toMatchObject({ ok: true, replyPreview: 'OK' });
    expect(network.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');

    await expect(client.discoverModels({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      apiKey: 'ds-key',
    })).resolves.toMatchObject([{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]);
    expect(network.mock.calls[1][0]).toBe('https://api.deepseek.com/models');

    await expect(client.testConnection({
      provider: 'deepseek',
      model: 'bad-model',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'ds-key',
    })).resolves.toMatchObject({ ok: false, error: 'DeepSeek returned HTTP 404: Model not found: bad-model' });

    await expect(client.testConnection({
      provider: 'openai',
      model: 'gpt-6.2-sol',
      apiKey: 'oa-key',
    })).resolves.toMatchObject({ ok: true, replyPreview: 'GPT-6 OK' });
    expect(JSON.parse(String(network.mock.calls[3][1]?.body))).toMatchObject({
      model: 'gpt-6.2-sol',
      max_completion_tokens: 64,
    });
  });

  it('supports native Google Gemini Interactions API (/v1beta/interactions) for Gemini 4 streaming, tools, and discovery', async () => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        id: 'inter_1',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'OK' }] }],
      }))
      .mockResolvedValueOnce(sse(
        { delta: { type: 'thought', thought: 'Planning analysis' } },
        { delta: { type: 'text', text: 'Inspecting data.' } },
        { index: 0, delta: { type: 'function_call', call_id: 'g4_call_1', name: tool.name, arguments_delta: '{"path":"counts.csv"}' } },
        { type: 'interaction.completed', usage: { total_input_tokens: 52, total_output_tokens: 18 } },
      ))
      .mockResolvedValueOnce(Response.json({
        outputs: [{ type: 'text', text: 'Done.' }],
      }))
      .mockResolvedValueOnce(Response.json({
        models: [{ name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', supportedGenerationMethods: ['interactions'] }],
      }));
    vi.stubGlobal('fetch', network);

    const client = new LlmClient({
      provider: 'gemini',
      model: 'gemini-4-hydrogen',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      apiKey: 'gemini-key',
      enableThinking: true,
    });

    await expect(client.testConnection({
      provider: 'gemini',
      model: 'gemini-4-hydrogen',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      apiKey: 'gemini-key',
    })).resolves.toMatchObject({ ok: true, replyPreview: 'OK' });
    expect(network.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toMatchObject({
      model: 'gemini-4-hydrogen',
      input: 'Reply with OK',
      store: false,
      generation_config: { thinking_level: 'low' },
    });

    const delta = vi.fn();
    const thought = vi.fn();
    const streamResult = await client.completeWithTools(messages, [tool], 900, { onDelta: delta, onThinkingDelta: thought });
    expect(streamResult).toMatchObject({
      text: 'Inspecting data.',
      thinking: 'Planning analysis',
      toolCalls: [{ id: 'g4_call_1', name: tool.name, arguments: { path: 'counts.csv' } }],
      usage: { inputTokens: 52, outputTokens: 18 },
    });
    expect(delta).toHaveBeenCalledExactlyOnceWith('Inspecting data.');
    expect(thought).toHaveBeenCalledExactlyOnceWith('Planning analysis');
    expect(network.mock.calls[1][0]).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');

    await expect(client.complete([
      ...messages,
      { role: 'assistant', content: streamResult!.text, toolCalls: streamResult!.toolCalls },
      { role: 'tool', name: tool.name, toolCallId: 'g4_call_1', content: '200 rows' },
    ])).resolves.toBe('Done.');
    const followBody = JSON.parse(String(network.mock.calls[2][1]?.body));
    expect(followBody.input.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'function_result', call_id: 'g4_call_1', name: tool.name, result: { output: '200 rows' } }],
    });

    await expect(client.discoverModels({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      apiKey: 'gemini-key',
    })).resolves.toMatchObject([{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }]);
    expect(network.mock.calls[3][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  });

  it('exports unique presets and detects configured environment providers in priority order', () => {
    expect(new Set(LLM_PROVIDER_IDS).size).toBe(15);
    expect(LLM_PROVIDER_PRESETS.every((preset) => preset.defaultModel && preset.supportsTools)).toBe(true);
    for (const { envKeyName } of LLM_PROVIDER_PRESETS) {
      if (envKeyName) vi.stubEnv(envKeyName, undefined);
    }
    expect(new LlmClient().getSafeSettings()).toMatchObject({ provider: 'anthropic', isConfigured: false, configuredProviders: [] });
    vi.stubEnv('GEMINI_API_KEY', 'gemini-env');
    expect(new LlmClient().getSafeSettings()).toMatchObject({ provider: 'gemini', isConfigured: true });
    vi.stubEnv('ANTHROPIC_API_KEY', 'claude-env');
    expect(new LlmClient().getSafeSettings()).toMatchObject({ provider: 'anthropic', configuredProviders: ['anthropic', 'gemini'] });
  });
});
