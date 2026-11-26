import { useEffect, useState, type FormEvent } from 'react';
import {
  BookOpen, Brain, Cable, CheckCircle2, ChevronDown, Cpu, Eye, GitBranch, Globe, Languages, Lock,
  RefreshCw, Server, ShieldCheck, SlidersHorizontal, Sparkles, Stethoscope, Users, Wifi, XCircle,
} from 'lucide-react';
import type {
  ComputeTarget, ConnectorInfo, CustomSpecialist, DiscoveredModelInfo, LlmProviderKind,
  LlmProviderPreset, ModelConnectionTestResult, ModelRoutingConfig, PythonEnvironmentInfo,
  SafeLlmSettings, SessionNode, SlurmJobRecord,
} from '@scideveloper/shared';
import { api, errorText, type CatalogSkill, type Health } from '../api';
import { useI18n, type Locale } from '../i18n';
import SessionDagTree from './SessionDagTree';
import { ComputePanel, ConnectorsPanel, DoctorPanel, SkillsPanel, SpecialistsPanel } from './SidePanels';
import { ErrorNote, Loading, Modal, Pill } from './ui';

type SettingsTab = 'general' | 'advanced';
type AdvancedSection = 'runtime' | 'routing' | 'doctor' | 'compute' | 'connectors' | 'skills' | 'specialists' | 'lineage';

export default function SettingsDialog({
  health, pythonVersion, targets, computeId, onChangeCompute,
  jobs, sessionId, nodes, selectedNodeId, loadedSkills, catalog, specialists, connectors, busy,
  onLoadSkill, onRefreshConnectors, onRefreshSpecialists, onRefreshTargets, onUpdateJob, onRefreshPending, onFork, onSelectNode,
  onClose, onSave,
}: {
  health?: Health;
  pythonVersion?: string;
  targets: ComputeTarget[];
  computeId?: string;
  onChangeCompute: (id: string) => void;
  jobs: SlurmJobRecord[];
  sessionId?: string;
  nodes: SessionNode[];
  selectedNodeId?: string | null;
  loadedSkills: string[];
  catalog: CatalogSkill[];
  specialists: CustomSpecialist[];
  connectors: ConnectorInfo[];
  busy: boolean;
  onLoadSkill: (name: string) => void;
  onRefreshConnectors: () => Promise<unknown>;
  onRefreshSpecialists: () => Promise<unknown>;
  onRefreshTargets: () => Promise<unknown>;
  onUpdateJob: (job: SlurmJobRecord) => void;
  onRefreshPending: () => Promise<unknown>;
  onFork: (id: string) => void;
  onSelectNode: (id: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { locale, setLocale, L } = useI18n();
  const [tab, setTab] = useState<SettingsTab>('general');
  const [advancedSection, setAdvancedSection] = useState<AdvancedSection>('runtime');
  const [presets, setPresets] = useState<LlmProviderPreset[]>([]);
  const [settings, setSettings] = useState<SafeLlmSettings>();
  const [provider, setProvider] = useState<LlmProviderKind>('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [enableThinking, setEnableThinking] = useState(true);
  const [thinkingBudget, setThinkingBudget] = useState(4096);
  const [allowLive, setAllowLive] = useState(true);
  const [enableVision, setEnableVision] = useState(true);
  const [strictSandbox, setStrictSandbox] = useState(true);
  const [memoryLimitMb, setMemoryLimitMb] = useState(4096);
  const [pyExec, setPyExec] = useState('');
  const [maxIter, setMaxIter] = useState(8);
  const [routing, setRouting] = useState<ModelRoutingConfig>({});
  const [pyEnvs, setPyEnvs] = useState<PythonEnvironmentInfo[]>([]);
  const [rRuntime, setRRuntime] = useState<{ available: boolean; persistentReady?: boolean; version?: string }>({ available: false });
  const [discovered, setDiscovered] = useState<DiscoveredModelInfo[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ModelConnectionTestResult>();
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    Promise.all([api.settings(), api.modelPresets()]).then(([value, list]) => {
      if (!live) return;
      setPresets(list);
      setSettings(value);
      setProvider(value.provider);
      const preset = list.find(p => p.id === value.provider);
      setModel(value.model || preset?.defaultModel || '');
      setBaseUrl(value.baseUrl || value.providerBaseUrls?.[value.provider] || preset?.defaultBaseUrl || '');
      setEnableThinking(value.enableThinking !== false);
      setThinkingBudget(value.thinkingBudgetTokens ?? 4096);
      setAllowLive(value.allowLiveConnectors !== false);
      setEnableVision(value.enableVisionAudit !== false);
      setMemoryLimitMb(value.memoryLimitMb ?? 4096);
      setPyExec(value.pythonExecutable ?? '');
      setMaxIter(value.maxAgentIterations ?? 8);
      setRouting(value.routing ?? {});
    }).catch(cause => { if (live) setError(errorText(cause)); });
    api.policy().then(pol => {
      if (live) setStrictSandbox(pol.strictSandboxGuard !== false);
    }).catch(() => {});
    api.computeEnvironments().then(res => {
      if (live) {
        setPyEnvs(res.pythonEnvironments ?? []);
        setRRuntime(res.rRuntime ?? { available: false });
      }
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  const currentPreset = presets.find(p => p.id === provider);
  const hasSavedKeyForProvider = Boolean(settings?.configuredProviders?.includes(provider));
  const needsVisibleBaseUrl = provider === 'openai-compatible' || provider === 'ollama'
    || Boolean(currentPreset && baseUrl.trim() && baseUrl.trim() !== currentPreset.defaultBaseUrl);

  function handleLanguageChange(next: Locale) {
    setLocale(next);
    void api.saveSettings({ language: next }).catch(() => {});
  }

  function handleSelectProvider(next: LlmProviderKind) {
    setProvider(next);
    setApiKeyInput('');
    setTestResult(undefined);
    setDiscovered([]);
    setSavedNotice('');
    const preset = presets.find(p => p.id === next);
    setModel(settings?.providerModels?.[next] || preset?.defaultModel || '');
    setBaseUrl(settings?.providerBaseUrls?.[next] || preset?.defaultBaseUrl || '');
  }

  async function runConnectionTest() {
    setTesting(true);
    setError('');
    setTestResult(undefined);
    try {
      const res = await api.testModel({
        provider,
        model: model.trim() || currentPreset?.defaultModel || '',
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKeyInput.trim() || undefined,
      });
      setTestResult(res);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setTesting(false);
    }
  }

  async function fetchProviderModels() {
    setDiscovering(true);
    setError('');
    try {
      const list = await api.discoverModels({
        provider,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKeyInput.trim() || undefined,
      });
      setDiscovered(list);
      if (list.length > 0 && !model.trim()) setModel(list[0].id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setDiscovering(false);
    }
  }

  async function persistSettings(closeAfter: boolean) {
    if (!settings || saving) return;
    if (!model.trim()) {
      setError(L('请输入或选择一个模型名称。', 'Please enter or select a model name.'));
      return;
    }
    setSaving(true); setError(''); setSavedNotice('');
    try {
      const saved = await api.saveSettings({
        provider,
        model: model.trim(),
        baseUrl: baseUrl.trim() || undefined,
        ...(apiKeyInput.trim() ? { apiKey: apiKeyInput.trim(), apiKeyProvider: provider } : {}),
        routing,
        temperature: settings.temperature,
        enableThinking,
        thinkingBudgetTokens: thinkingBudget,
        allowLiveConnectors: allowLive,
        enableVisionAudit: enableVision,
        memoryLimitMb,
        pythonExecutable: pyExec || undefined,
        maxAgentIterations: maxIter,
        language: locale,
      });
      await api.savePolicy({ strictSandboxGuard: strictSandbox });
      setSettings(saved);
      setApiKeyInput('');
      setSavedNotice(L('设置已保存并加密存储。', 'Settings saved and encrypted.'));
      onSave();
      if (closeAfter) onClose();
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void persistSettings(tab === 'general');
  }

  const online = health?.ok === true;
  const pythonReady = online && health?.pythonAvailable !== false;
  const activeTargetName = targets.find(t => t.id === computeId)?.name ?? L('本地沙箱', 'Local Sandbox');
  const modelChoices = [
    ...new Set([
      ...(discovered.map(m => m.id)),
      ...(currentPreset?.suggestedModels ?? []),
      ...(model ? [model] : []),
    ]),
  ];

  function updateRoute(role: keyof ModelRoutingConfig, field: 'provider' | 'model', value: string) {
    setRouting(prev => {
      const existing = prev[role];
      if (!value && field === 'provider') {
        const next = { ...prev };
        delete next[role];
        return next;
      }
      const nextProvider = (field === 'provider' ? value : existing?.provider ?? provider) as LlmProviderKind;
      const preset = presets.find(p => p.id === nextProvider);
      return {
        ...prev,
        [role]: {
          provider: nextProvider,
          model: field === 'model' ? value : (existing?.provider === nextProvider ? existing.model : preset?.defaultModel ?? ''),
        },
      };
    });
  }

  const baseUrlField = (
    <label>
      {L('接口地址 (Base URL)', 'API Base URL')}
      <span className="field-help">
        {L('使用官方服务时保持默认即可；仅在使用中转代理或自建网关时需要修改。', 'Keep the default for official APIs; only change this for proxies or self-hosted gateways.')}
      </span>
      <div className="input-action-row">
        <input
          type="url"
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder={currentPreset?.defaultBaseUrl || 'https://api.openai.com/v1'}
        />
        {currentPreset && baseUrl.trim() !== currentPreset.defaultBaseUrl && (
          <button
            type="button"
            className="btn"
            onClick={() => setBaseUrl(currentPreset.defaultBaseUrl)}
            title={L(`恢复默认地址：${currentPreset.defaultBaseUrl}`, `Restore default URL: ${currentPreset.defaultBaseUrl}`)}
          >
            {L('恢复默认', 'Reset')}
          </button>
        )}
      </div>
    </label>
  );

  return (
    <Modal
      title={L('设置', 'Settings')}
      subtitle={L('调整语言、连接 AI 模型，或在高级设置中管理计算环境与扩展工具', 'Configure language and AI model, or manage runtimes and extensions in Advanced')}
      size="lg"
      onClose={onClose}
    >
      <nav className="settings-tabs" aria-label={L('设置分类', 'Settings sections')}>
        <button type="button" className={tab === 'general' ? 'selected' : ''} onClick={() => setTab('general')}>
          <Sparkles size={15} />{L('常规设置', 'General')}
        </button>
        <button type="button" className={tab === 'advanced' ? 'selected' : ''} onClick={() => setTab('advanced')}>
          <SlidersHorizontal size={15} />{L('高级设置', 'Advanced')}
        </button>
      </nav>

      {error && <ErrorNote>{error}</ErrorNote>}

      {tab === 'general' && (
        <div className="stack">
          {/* Language switcher inside General Settings */}
          <section className="settings-section">
            <div className="settings-row-between">
              <div className="min-w-0">
                <div className="settings-item-title">
                  <Languages size={15} className="text-teal" />
                  <strong>{L('界面语言', 'Interface Language')}</strong>
                </div>
                <p className="field-help">
                  {L('切换整个应用的显示语言（包含主界面、结果面板及所有设置项）。', 'Switches display language across the entire app, including results panels and settings.')}
                </p>
              </div>
              <div className="segmented-toggle" role="group" aria-label={L('界面语言', 'Interface Language')}>
                <button
                  type="button"
                  className={locale === 'zh' ? 'selected' : ''}
                  onClick={() => handleLanguageChange('zh')}
                >
                  简体中文
                </button>
                <button
                  type="button"
                  className={locale === 'en' ? 'selected' : ''}
                  onClick={() => handleLanguageChange('en')}
                >
                  English
                </button>
              </div>
            </div>
          </section>

          {!settings && !error && <Loading label={L('正在加载设置…', 'Loading settings…')} />}

          {settings && (
            <form className="form-stack" onSubmit={handleFormSubmit}>
              {/* AI Model Selection */}
              <section className="settings-section stack">
                <div>
                  <div className="settings-item-title">
                    <Sparkles size={15} className="text-teal" />
                    <strong>{L('AI 模型连接', 'AI Model')}</strong>
                  </div>
                  <p className="field-help">
                    {L('选择您常用的大模型平台并填入 API Key，密钥仅在本地加密保存。', 'Choose your AI platform and enter an API key. Keys are stored encrypted on this device.')}
                  </p>
                </div>

                <div className="provider-grid" role="radiogroup" aria-label={L('模型平台', 'AI Model Platform')}>
                  {presets.map(p => {
                    const configured = settings.configuredProviders.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={'provider-chip' + (provider === p.id ? ' selected' : '')}
                        onClick={() => handleSelectProvider(p.id)}
                      >
                        <div className="provider-chip-head">
                          <strong>{p.name}</strong>
                          {configured && <span className="provider-ready-dot" title={L('已配置密钥', 'Key configured')} />}
                        </div>
                        <span className="muted truncate" style={{ fontSize: 11.5, width: '100%' }}>{p.defaultModel}</span>
                      </button>
                    );
                  })}
                </div>

                <label>
                  {L('模型名称', 'Model')}
                  <span className="field-help">
                    {L('可直接点选下方推荐模型，或手动输入平台支持的任意模型 ID。', 'Pick a suggested model below or type any model ID supported by this provider.')}
                  </span>
                  <input
                    list="scidev-model-choices"
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    placeholder={currentPreset?.defaultModel || L('输入模型名称', 'Enter model ID')}
                    required
                  />
                  <datalist id="scidev-model-choices">
                    {modelChoices.map(id => <option key={id} value={id} />)}
                  </datalist>
                </label>

                {modelChoices.length > 0 && (
                  <div className="pills" style={{ gap: 5 }}>
                    {modelChoices.slice(0, 8).map(id => (
                      <button
                        key={id}
                        type="button"
                        className={'tab-pill' + (model === id ? ' selected' : '')}
                        onClick={() => setModel(id)}
                        title={id}
                      >
                        <span className="truncate">{id}</span>
                      </button>
                    ))}
                    {modelChoices.length > 8 && (
                      <select
                        aria-label={L('更多模型', 'More models')}
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        style={{ padding: '3px 8px', fontSize: 12, maxWidth: 210 }}
                      >
                        <option value={model}>{L(`+${modelChoices.length - 8} 个更多模型…`, `+${modelChoices.length - 8} more models…`)}</option>
                        {modelChoices.map(id => <option key={id} value={id}>{id}</option>)}
                      </select>
                    )}
                  </div>
                )}

                {(currentPreset?.requiresApiKey !== false || provider === 'openai-compatible') && (
                  <label>
                    {L(`${currentPreset?.name ?? provider} API Key`, `${currentPreset?.name ?? provider} API Key`)}
                    <span className="field-help">
                      {hasSavedKeyForProvider
                        ? L('本机已加密保存该平台的密钥，如需更换请粘贴新密钥。', 'An encrypted key is already saved for this provider; paste a new one only to replace it.')
                        : currentPreset?.requiresApiKey === false
                          ? L('可选；本地网关如无需鉴权可直接留空。', 'Optional; leave blank if your local gateway does not require authentication.')
                          : L('从模型平台控制台获取并粘贴，密钥仅保存在您本地设备。', 'Paste the key from your provider console; it stays encrypted on your machine.')}
                    </span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={apiKeyInput}
                      onChange={e => setApiKeyInput(e.target.value)}
                      placeholder={hasSavedKeyForProvider
                        ? L('已保存加密密钥 · 输入新密钥可覆盖', 'Saved in vault · paste to replace')
                        : L('粘贴 API Key…', 'Paste API key…')}
                    />
                  </label>
                )}

                {needsVisibleBaseUrl ? (
                  baseUrlField
                ) : (
                  <details className="subtle-details">
                    <summary>
                      <ChevronDown size={13} />
                      {L('自定义接口地址 / 代理（可选）', 'Custom API Base URL / Proxy (optional)')}
                    </summary>
                    <div className="mt-2">{baseUrlField}</div>
                  </details>
                )}

                <div className="actions justify-start">
                  <button type="button" className="btn" disabled={testing || !model.trim()} onClick={() => void runConnectionTest()}>
                    <Wifi size={13} />{testing ? L('正在测试…', 'Testing…') : L('测试连接', 'Test Connection')}
                  </button>
                  <button type="button" className="btn" disabled={discovering} onClick={() => void fetchProviderModels()}>
                    <RefreshCw size={13} />{discovering ? L('获取中…', 'Fetching…') : L('获取可用模型', 'Fetch Models')}
                  </button>
                  {discovered.length > 0 && <Pill tone="teal">{L(`已加载 ${discovered.length} 个模型`, `${discovered.length} loaded`)}</Pill>}
                </div>

                {testResult && (
                  <div className="soft-card pills">
                    {testResult.ok ? <CheckCircle2 size={15} className="text-teal" /> : <XCircle size={15} className="text-red" />}
                    <strong>{testResult.ok ? L(`连接成功 (${testResult.latencyMs}ms)`, `Connected (${testResult.latencyMs}ms)`) : L('连接失败', 'Connection Failed')}</strong>
                    <span className="muted">{testResult.ok ? testResult.replyPreview : testResult.error}</span>
                  </div>
                )}
              </section>

              {/* Everyday Research Preferences (only 2 clear toggles with plain explanations) */}
              <section className="settings-section stack">
                <div>
                  <div className="settings-item-title">
                    <SlidersHorizontal size={15} className="text-teal" />
                    <strong>{L('常用科研偏好', 'Research Preferences')}</strong>
                  </div>
                </div>

                <label className="checkbox-row">
                  <input type="checkbox" checked={enableThinking} onChange={e => setEnableThinking(e.target.checked)} />
                  <span className="option-explain">
                    <strong><Brain size={14} className="inline-icon" />{L('深度思考模式', 'Extended Thinking')}</strong>
                    <span className="field-help">
                      {L('让 AI 在给出结论前先进行更深入的推理与规划，适合复杂实验设计与统计分析（响应会稍慢一些）。', 'Lets the AI reason step-by-step before answering complex scientific questions (slightly slower, more thorough).')}
                    </span>
                  </span>
                </label>

                <label className="checkbox-row">
                  <input type="checkbox" checked={allowLive} onChange={e => setAllowLive(e.target.checked)} />
                  <span className="option-explain">
                    <strong><Globe size={14} className="inline-icon" />{L('在线科学数据库检索', 'Live Scientific Databases')}</strong>
                    <span className="field-help">
                      {L('开启后可实时查询 PubMed、RCSB PDB、UniProt、ChEMBL 等在线权威数据库；关闭后将仅使用本地缓存数据。', 'Queries live PubMed, PDB, UniProt, ChEMBL, and other databases; turn off to use offline cached data.')}
                    </span>
                  </span>
                </label>
              </section>

              {savedNotice && <p role="status" className="muted">{savedNotice}</p>}
              <div className="settings-footer-bar">
                <span className="muted" style={{ fontSize: 12 }}>SciDeveloper v0.5.0</span>
                <div className="actions">
                  <button type="button" className="btn" onClick={onClose}>{L('取消', 'Cancel')}</button>
                  <button className="btn btn-primary" disabled={saving}>
                    {saving ? L('正在保存…', 'Saving…') : L('保存设置', 'Save Settings')}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}

      {tab === 'advanced' && (
        <div className="stack">
          <p className="field-help" style={{ margin: 0 }}>
            {L(
              '以下为进阶配置，大多数科研场景使用默认参数即可，无需频繁修改。',
              'Advanced parameters for power users and lab admins. Default values work well for most research workflows.',
            )}
          </p>

          <div className="pill-strip" aria-label={L('高级设置分类', 'Advanced sections')}>
            <button type="button" className={'tab-pill' + (advancedSection === 'runtime' ? ' selected' : '')} onClick={() => setAdvancedSection('runtime')}>
              <ShieldCheck size={13} />{L('运行与安全', 'Runtime & Safety')}
            </button>
            <button type="button" className={'tab-pill' + (advancedSection === 'routing' ? ' selected' : '')} onClick={() => setAdvancedSection('routing')}>
              <Cpu size={13} />{L('多模型分工', 'Role Routing')}
            </button>
            <button type="button" className={'tab-pill' + (advancedSection === 'doctor' ? ' selected' : '')} onClick={() => setAdvancedSection('doctor')}>
              <Stethoscope size={13} />{L('环境体检', 'Doctor')}
            </button>
            <button type="button" className={'tab-pill' + (advancedSection === 'compute' ? ' selected' : '')} onClick={() => setAdvancedSection('compute')}>
              <Server size={13} />{L('算力集群', 'Compute')}
            </button>
            <button type="button" className={'tab-pill' + (advancedSection === 'connectors' ? ' selected' : '')} onClick={() => setAdvancedSection('connectors')}>
              <Cable size={13} />{L(`数据源 (${connectors.length})`, `Connectors (${connectors.length})`)}
            </button>
            <button type="button" className={'tab-pill' + (advancedSection === 'skills' ? ' selected' : '')} onClick={() => setAdvancedSection('skills')}>
              <BookOpen size={13} />{L(`科研协议 (${catalog.length})`, `Protocols (${catalog.length})`)}
            </button>
            <button type="button" className={'tab-pill' + (advancedSection === 'specialists' ? ' selected' : '')} onClick={() => setAdvancedSection('specialists')}>
              <Users size={13} />{L(`自定义专家 (${specialists.length})`, `Specialists (${specialists.length})`)}
            </button>
            <button type="button" className={'tab-pill' + (advancedSection === 'lineage' ? ' selected' : '')} onClick={() => setAdvancedSection('lineage')}>
              <GitBranch size={13} />{L('会话分支树', 'Session Tree')}
            </button>
          </div>

          <div className="advanced-body">
            {advancedSection === 'runtime' && (
              <div className="stack">
                <div className="soft-card engine-status-card stack">
                  <div className="card-head">
                    <strong>{L('本地运行环境概览', 'Local Runtime Status')}</strong>
                    <div className="pills">
                      <Pill tone={pythonReady ? 'teal' : 'amber'}>{pythonReady ? L('Python 就绪', 'Python Ready') : L('Python 不可用', 'Python Unavailable')}</Pill>
                      <Pill tone={rRuntime.available ? 'teal' : 'neutral'}>{rRuntime.available ? `R ${rRuntime.version ?? L('就绪', 'Ready')}` : L('未安装 R', 'R Not Installed')}</Pill>
                      <Pill tone={health?.dockerAvailable ? 'teal' : 'neutral'}>{health?.dockerAvailable ? `Docker ${health.dockerVersion ?? L('就绪', 'Ready')}` : L('Docker 未启动', 'Docker Offline')}</Pill>
                      {settings?.keyProtection && settings.keyProtection !== 'none' && (
                        <Pill tone="blue"><Lock size={11} />{settings.keyProtection === 'dpapi-safe-storage' ? L('系统安全库加密', 'DPAPI Vault') : L('AES-256 加密', 'AES-256 Vault')}</Pill>
                      )}
                    </div>
                  </div>
                  <p className="muted">
                    {L('当前计算环境：', 'Compute: ')}<strong>{activeTargetName}</strong>
                    {pythonReady && pythonVersion ? <> · Python <code>{pythonVersion.replace(/^Python\s+/i, '')}</code></> : null}
                  </p>
                </div>

                {settings && (
                  <form className="form-stack" onSubmit={e => { e.preventDefault(); void persistSettings(false); }}>
                    {pyEnvs.length > 0 && (
                      <label>
                        {L('Python / Conda 环境', 'Python / Conda Environment')}
                        <span className="field-help">
                          {L('指定本地运行数据分析脚本时使用的 Python 解释器或 Conda 虚拟环境。', 'Select which local Python or Conda environment runs analysis scripts.')}
                        </span>
                        <select value={pyExec} onChange={e => setPyExec(e.target.value)}>
                          <option value="">{L('系统默认 Python', 'System Default Python')}</option>
                          {pyEnvs.map(env => (
                            <option key={env.id} value={env.executable}>
                              {env.name} ({env.kind}{env.version ? ` · ${env.version}` : ''})
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    <div className="form-grid">
                      <label>
                        {L(`单次分析最大轮次 (${maxIter})`, `Max Analysis Steps (${maxIter})`)}
                        <span className="field-help">
                          {L('限制 AI 每次回答最多自动调用工具/执行代码的步数，推荐 6–10。', 'Caps how many autonomous tool/code steps the AI takes per turn (recommended: 6–10).')}
                        </span>
                        <input type="range" min={2} max={16} value={maxIter} onChange={e => setMaxIter(Number(e.target.value))} />
                      </label>

                      <label>
                        {L('沙箱内存上限 (MB)', 'Sandbox Memory Limit (MB)')}
                        <span className="field-help">
                          {L('限制单次脚本可占用的最大内存，防止大数据集卡死电脑（默认 4096）。', 'Prevents large datasets from exhausting system RAM (default: 4096 MB).')}
                        </span>
                        <input type="number" min={512} max={65536} step={512} value={memoryLimitMb} onChange={e => setMemoryLimitMb(Number(e.target.value))} />
                      </label>
                    </div>

                    <label>
                      {L(`深度思考预算上限 (${thinkingBudget} tokens)`, `Thinking Token Budget (${thinkingBudget} tokens)`)}
                      <span className="field-help">
                        {L('控制开启“深度思考模式”时的最大内部推理长度，数值越大越细致但消耗更多额度。', 'Sets maximum reasoning depth when Extended Thinking is enabled. Higher values use more tokens.')}
                      </span>
                      <input type="range" min={1024} max={16384} step={1024} value={thinkingBudget} onChange={e => setThinkingBudget(Number(e.target.value))} />
                    </label>

                    <label className="checkbox-row">
                      <input type="checkbox" checked={strictSandbox} onChange={e => setStrictSandbox(e.target.checked)} />
                      <span className="option-explain">
                        <strong><ShieldCheck size={14} className="inline-icon" />{L('严格沙箱安全防护', 'Strict Sandbox Guard')}</strong>
                        <span className="field-help">
                          {L('以只读方式保护您的原始实验数据文件，并拦截分析代码未经授权的网络外连，强烈建议保持开启。', 'Protects raw data files as read-only and blocks unauthorized outbound network calls. Recommended to keep enabled.')}
                        </span>
                      </span>
                    </label>

                    <label className="checkbox-row">
                      <input type="checkbox" checked={enableVision} onChange={e => setEnableVision(e.target.checked)} />
                      <span className="option-explain">
                        <strong><Eye size={14} className="inline-icon" />{L('图表视觉自动质检', 'Visual Figure Inspection')}</strong>
                        <span className="field-help">
                          {L('生成 PNG 科研图表后，自动调用视觉模型检查文字遮挡、坐标轴标签与排版美观度。', 'Automatically inspects generated PNG figures with a vision model to catch overlapping labels or layout flaws.')}
                        </span>
                      </span>
                    </label>

                    {savedNotice && <p role="status" className="muted">{savedNotice}</p>}
                    <div className="actions">
                      <button className="btn btn-primary" disabled={saving}>
                        {saving ? L('正在保存…', 'Saving…') : L('保存高级参数', 'Save Runtime Settings')}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {advancedSection === 'routing' && settings && (
              <form className="form-stack" onSubmit={e => { e.preventDefault(); void persistSettings(false); }}>
                <p className="field-help" style={{ margin: 0 }}>
                  {L(
                    '可为不同后台角色单独指定更经济或更快速的模型（例如主对话用旗舰模型，质检或上下文压缩用轻量模型）。留空则默认沿用主模型。',
                    'Optionally assign separate models to background roles (e.g. a faster or lower-cost model for reviews and context compaction). Leave blank to inherit your primary model.',
                  )}
                </p>
                {(['subagent', 'reviewer', 'compaction'] as const).map(role => {
                  const entry = routing[role];
                  const roleInfo = {
                    subagent: {
                      title: L('并行子任务助手', 'Parallel Specialist Sub-Agents'),
                      desc: L('负责并行执行具体数据清洗、统计或检索子任务。', 'Runs delegated data analysis or retrieval subtasks in parallel.'),
                    },
                    reviewer: {
                      title: L('后台质量审查与图表核验', 'Background Quality Reviewer'),
                      desc: L('负责核对报告数字、文献引用与图表排版。', 'Audits reported numbers, citations, and visual figure quality.'),
                    },
                    compaction: {
                      title: L('长对话上下文压缩', 'Context Compaction Summarizer'),
                      desc: L('对话很长时自动摘要历史上下文，节省 Token。', 'Summarizes older turns when a long conversation approaches the context limit.'),
                    },
                  }[role];
                  return (
                    <div key={role} className="soft-card stack">
                      <div>
                        <strong>{roleInfo.title}</strong>
                        <p className="field-help">{roleInfo.desc}</p>
                      </div>
                      <div className="form-grid">
                        <label>{L('平台', 'Provider')}
                          <select
                            value={entry?.provider ?? ''}
                            onChange={e => updateRoute(role, 'provider', e.target.value)}
                          >
                            <option value="">{L(`沿用主模型 (${provider})`, `Inherit primary (${provider})`)}</option>
                            {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </label>
                        <label>{L('模型 ID', 'Model ID')}
                          <input
                            value={entry?.model ?? ''}
                            disabled={!entry?.provider}
                            placeholder={entry?.provider ? presets.find(p => p.id === entry.provider)?.defaultModel : L('沿用主模型', 'Inherited')}
                            onChange={e => updateRoute(role, 'model', e.target.value)}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
                {savedNotice && <p role="status" className="muted">{savedNotice}</p>}
                <div className="actions">
                  <button className="btn btn-primary" disabled={saving}>
                    {saving ? L('正在保存…', 'Saving…') : L('保存分工配置', 'Save Role Routing')}
                  </button>
                </div>
              </form>
            )}

            {advancedSection === 'doctor' && (
              <DoctorPanel sessionId={sessionId} refreshPending={onRefreshPending} />
            )}

            {advancedSection === 'compute' && (
              <div className="stack">
                <label className="form-field">
                  {L('当前使用的计算环境', 'Active compute environment')}
                  <span className="field-help">
                    {L('默认在本地 Python/R 沙箱运行；若实验室配置了远程 SSH 或 Slurm 集群，可在此切换。', 'Runs in the local sandbox by default; switch here if you use a remote SSH workstation or Slurm cluster.')}
                  </span>
                  <select aria-label={L('当前计算环境', 'Active compute target')} value={computeId ?? ''} disabled={!targets.length}
                    onChange={event => onChangeCompute(event.target.value)}>
                    {!targets.some(target => target.id === computeId) && <option value={computeId ?? ''}>{computeId ?? L('本地沙箱', 'Local Sandbox')}</option>}
                    {targets.map(target => <option value={target.id} key={target.id}>{target.name}</option>)}
                  </select>
                </label>
                <ComputePanel targets={targets} jobs={jobs} computeId={computeId} sessionId={sessionId}
                  onJob={onUpdateJob} refreshPending={onRefreshPending} refreshTargets={onRefreshTargets} />
              </div>
            )}

            {advancedSection === 'connectors' && (
              <ConnectorsPanel connectors={connectors} refresh={onRefreshConnectors} />
            )}

            {advancedSection === 'skills' && (
              <SkillsPanel catalog={catalog} loadedSkills={loadedSkills} onLoad={onLoadSkill} />
            )}

            {advancedSection === 'specialists' && (
              <SpecialistsPanel specialists={specialists} refresh={onRefreshSpecialists} />
            )}

            {advancedSection === 'lineage' && (
              sessionId
                ? <SessionDagTree nodes={nodes} activeId={selectedNodeId} disabled={busy}
                    onFork={id => { onFork(id); onClose(); }}
                    onSelect={id => { onSelectNode(id); onClose(); }} />
                : <p className="muted">{L('打开一个研究对话后，可在此查看完整步骤树或从任意节点创建分支。', 'Open a research conversation to view or branch its step history.')}</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
