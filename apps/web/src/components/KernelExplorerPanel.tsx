import { useCallback, useEffect, useState } from 'react';
import { Play, RefreshCw, RotateCcw, Terminal, Variable } from 'lucide-react';
import type { KernelVariableInfo, ScientificArtifact } from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { CodeBlock, ErrorNote, Loading, Pill } from './ui';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function KernelExplorerPanel({
  sessionId,
  initialCode,
  initialLanguage = 'python',
  sourceArtifactId,
  onExecuted,
}: {
  sessionId: string;
  initialCode?: string;
  initialLanguage?: 'python' | 'r';
  sourceArtifactId?: string;
  onExecuted?: (artifacts: ScientificArtifact[]) => void;
}) {
  const { t, L } = useI18n();
  const [language, setLanguage] = useState<'python' | 'r'>(initialLanguage);
  const [code, setCode] = useState(
    initialCode ||
      '# Interactive scientific cell — variables persist across runs\nimport numpy as np\nimport pandas as pd\nprint("Kernel ready")',
  );
  const [running, setRunning] = useState(false);
  const [stdout, setStdout] = useState('');
  const [stderr, setStderr] = useState('');
  const [exitCode, setExitCode] = useState<number>();
  const [durationMs, setDurationMs] = useState<number>();
  const [error, setError] = useState('');
  const [vars, setVars] = useState<{ python: KernelVariableInfo[]; r: KernelVariableInfo[] }>({ python: [], r: [] });
  const [loadingVars, setLoadingVars] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (initialCode) setCode(initialCode);
  }, [initialCode]);

  useEffect(() => {
    setLanguage(initialLanguage);
  }, [initialLanguage]);

  const refreshVars = useCallback(async () => {
    setLoadingVars(true);
    try {
      setVars(await api.kernelVariables(sessionId));
    } catch {
      // ignore initial idle kernel
    } finally {
      setLoadingVars(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refreshVars();
  }, [refreshVars]);

  async function runCell() {
    if (!code.trim() || running) return;
    setRunning(true);
    setError('');
    try {
      const res = await api.runCodeCell(sessionId, {
        language,
        code,
        title: `Interactive ${language.toUpperCase()} Cell`,
        sourceArtifactId,
      });
      setStdout(res.stdout);
      setStderr(res.stderr);
      setExitCode(res.exitCode);
      setDurationMs(res.durationMs);
      onExecuted?.(res.artifacts);
      await refreshVars();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRunning(false);
    }
  }

  async function restart() {
    setResetting(true);
    setError('');
    try {
      await api.resetKernel(sessionId, language);
      setStdout('');
      setStderr('');
      setExitCode(undefined);
      await refreshVars();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setResetting(false);
    }
  }

  const activeVars = language === 'python' ? vars.python : vars.r;

  return (
    <div className="stack">
      <div className="soft-card stack">
        <div className="card-head">
          <Terminal size={15} />
          <strong>{L('交互式代码运行格', 'Interactive Code Cell')}</strong>
          <div className="actions" style={{ marginLeft: 'auto' }}>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as 'python' | 'r')}
              aria-label={L('运行语言', 'Kernel language')}
              style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--line-strong)', background: 'var(--surface)' }}
            >
              <option value="python">Python 3</option>
              <option value="r">R</option>
            </select>
            <button type="button" className="btn" disabled={resetting || running} onClick={() => void restart()}>
              <RotateCcw size={13} />{t('restartKernel')}
            </button>
            <button type="button" className="btn btn-primary" disabled={running || !code.trim()} onClick={() => void runCell()}>
              <Play size={13} />{running ? L('运行中…', 'Running…') : t('runCell')}
            </button>
          </div>
        </div>

        <textarea
          className="code-editor-area"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={11}
          spellCheck={false}
          aria-label={L('可编辑的科研代码', 'Editable scientific script')}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void runCell();
            }
          }}
        />
        <span className="muted" style={{ fontSize: 11.5 }}>
          {L('按 Ctrl+Enter 运行；代码中的变量会在同一对话内持续保留。', 'Press Ctrl+Enter to run. Variables persist across runs within this session.')}
        </span>

        {error && <ErrorNote>{error}</ErrorNote>}
        {exitCode !== undefined && (
          <div className="stack">
            <div className="pills">
              <Pill tone={exitCode === 0 ? 'teal' : 'red'}>{exitCode === 0 ? L('执行成功', 'Exit 0') : L(`退出码 ${exitCode}`, `Exit ${exitCode}`)}</Pill>
              {durationMs !== undefined && <Pill>{durationMs} ms</Pill>}
            </div>
            {stdout && <CodeBlock text={stdout} />}
            {stderr && <ErrorNote>{stderr}</ErrorNote>}
          </div>
        )}
      </div>

      <div className="soft-card stack">
        <div className="card-head">
          <Variable size={15} />
          <strong>{t('variables')} ({activeVars.length})</strong>
          <button
            type="button"
            className="btn"
            style={{ marginLeft: 'auto' }}
            disabled={loadingVars}
            onClick={() => void refreshVars()}
          >
            <RefreshCw size={13} />{L('刷新', 'Refresh')}
          </button>
        </div>

        {loadingVars && <Loading label={L('正在读取内核变量…', 'Inspecting kernel memory…')} />}
        {!loadingVars && activeVars.length === 0 && <p className="muted">{t('noVariables')}</p>}
        {activeVars.length > 0 && (
          <div className="stack">
            {activeVars.map((v) => (
              <div key={v.name} className="kv-card">
                <div className="pills">
                  <code><strong>{v.name}</strong></code>
                  <Pill tone="blue">{v.typeName}</Pill>
                  {v.shape && <Pill tone="teal">{v.shape}</Pill>}
                  {v.sizeBytes ? <Pill>{formatBytes(v.sizeBytes)}</Pill> : null}
                </div>
                {v.columns && v.columns.length > 0 && (
                  <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                    {L('列名：', 'Columns: ')}{v.columns.slice(0, 10).join(', ')}{v.columns.length > 10 ? ` (+${v.columns.length - 10})` : ''}
                  </p>
                )}
                {v.preview && (
                  <pre className="var-preview">{v.preview}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
