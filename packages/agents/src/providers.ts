import type { LlmProviderKind, LlmProviderPreset } from '@scideveloper/shared';

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: 'anthropic', name: 'Anthropic Claude', protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5-5',
    suggestedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-4-6'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 1_000_000, envKeyName: 'ANTHROPIC_API_KEY',
    description: 'Claude 5.5 / 5 / 4.6 models via the native Anthropic Messages API.',
  },
  {
    id: 'openai', name: 'OpenAI', protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6.2-sol',
    suggestedModels: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 400_000, envKeyName: 'OPENAI_API_KEY',
    description: 'GPT-6.2 & GPT-5.6 frontier reasoning models via Chat Completions.',
  },
  {
    id: 'gemini', name: 'Google Gemini', protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-4-hydrogen',
    suggestedModels: ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-2.5-pro'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 1_000_000, envKeyName: 'GEMINI_API_KEY',
    description: 'Gemini 4 & 3.8 via Google AI Studio (supports both /v1beta/interactions and /v1beta generateContent).',
  },
  {
    id: 'deepseek', name: 'DeepSeek', protocol: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-flash',
    suggestedModels: ['deepseek-flash', 'deepseek-v4-pro'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 1_000_000, envKeyName: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek V4.1 Flash (1M multimodal + thinking) & V4 Pro reasoning models.',
  },
  {
    id: 'openrouter', name: 'OpenRouter', protocol: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-sonnet-5-5',
    suggestedModels: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'openai/gpt-6.2-astra', 'google/gemini-4-carbon', 'deepseek/deepseek-v4-pro'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 1_000_000, envKeyName: 'OPENROUTER_API_KEY',
    description: 'A unified OpenAI-compatible gateway for frontier models across all major labs.',
  },
  {
    id: 'xai', name: 'xAI Grok', protocol: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.7',
    suggestedModels: ['grok-4.7', 'grok-4.20', 'grok-3'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 256_000, envKeyName: 'XAI_API_KEY',
    description: 'Grok 4.7 frontier reasoning, coding, and multimodal models.',
  },
  {
    id: 'azure-openai', name: 'Azure OpenAI', protocol: 'openai',
    defaultBaseUrl: 'https://your-resource.openai.azure.com/openai/v1', defaultModel: 'gpt-6.2-sol',
    suggestedModels: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-5.6-sol', 'gpt-4.1'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 256_000, envKeyName: 'AZURE_OPENAI_API_KEY',
    description: 'Use your Azure resource URL and deployment name.',
  },
  {
    id: 'together', name: 'Together AI', protocol: 'openai',
    defaultBaseUrl: 'https://api.together.xyz/v1', defaultModel: 'deepseek-ai/DeepSeek-V4',
    suggestedModels: ['deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3-235B-A22B-Instruct', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 256_000, envKeyName: 'TOGETHER_API_KEY',
    description: 'Hosted open-weight frontier chat and reasoning models.',
  },
  {
    id: 'siliconflow', name: 'SiliconFlow 硅基流动', protocol: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'deepseek-ai/DeepSeek-V4',
    suggestedModels: ['deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3-235B-A22B', 'zai-org/GLM-5'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 256_000, envKeyName: 'SILICONFLOW_API_KEY',
    description: 'Hosted DeepSeek, Qwen, GLM, and other open-weight models.',
  },
  {
    id: 'dashscope', name: 'Alibaba DashScope 通义千问', protocol: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-max',
    suggestedModels: ['qwen-max', 'qwen3.6-plus', 'qwen3.5-flash', 'qwq-max', 'qwen3-vl-plus'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 1_000_000, envKeyName: 'DASHSCOPE_API_KEY',
    description: 'Qwen4 / Qwen3.6 models via the DashScope OpenAI-compatible endpoint.',
  },
  {
    id: 'zhipu', name: 'Zhipu AI 智谱 GLM', protocol: 'openai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.4',
    suggestedModels: ['glm-5.4', 'glm-5.3', 'glm-5v-turbo', 'glm-4-plus'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 1_000_000, envKeyName: 'ZHIPU_API_KEY',
    description: 'GLM-5.4 / 5.3 frontier coding, reasoning, and vision models.',
  },
  {
    id: 'moonshot', name: 'Moonshot Kimi', protocol: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3.1-pro',
    suggestedModels: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'],
    requiresApiKey: true, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 1_000_000, envKeyName: 'MOONSHOT_API_KEY',
    description: 'Kimi K3.1 Pro (1M context, native vision & deep reasoning).',
  },
  {
    id: 'ollama', name: 'Ollama Local', protocol: 'ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434', defaultModel: 'qwen3:32b',
    suggestedModels: ['qwen3:32b', 'deepseek-r1:32b', 'llama4:scout', 'gemma3:27b', 'llama3.1'],
    requiresApiKey: false, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 131_072,
    description: 'Models installed locally on an Ollama server.',
  },
  {
    id: 'lmstudio', name: 'LM Studio Local', protocol: 'openai',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'local-model',
    suggestedModels: ['local-model'],
    requiresApiKey: false, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 131_072,
    description: 'Models served locally by LM Studio.',
  },
  {
    id: 'openai-compatible', name: 'Custom OpenAI-Compatible / vLLM / LiteLLM', protocol: 'openai',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1', defaultModel: 'custom-model',
    suggestedModels: [],
    requiresApiKey: false, supportsVision: true, supportsThinking: true, supportsTools: true,
    contextWindowDefault: 256_000,
    description: 'Any custom endpoint implementing OpenAI Chat Completions (One-API, LiteLLM, vLLM).',
  },
];

const presetsById = new Map(LLM_PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
export const LLM_PROVIDER_IDS = LLM_PROVIDER_PRESETS.map(({ id }) => id);

export function getProviderPreset(id: LlmProviderKind): LlmProviderPreset {
  const preset = presetsById.get(id);
  if (!preset) throw new RangeError('Unknown LLM provider: ' + id);
  return preset;
}

export function defaultLlmProvider(): LlmProviderKind {
  return LLM_PROVIDER_PRESETS.slice(0, 5).find(({ envKeyName }) =>
    envKeyName && process.env[envKeyName]?.trim())?.id ?? 'anthropic';
}
