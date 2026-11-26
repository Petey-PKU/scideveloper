import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2, ChevronDown, Code2, Cpu, Download, GitFork, History, PlayCircle,
  Shield, Upload, AlertTriangle,
} from 'lucide-react';
import type {
  BundleReplayResult, ProvenanceManifest, ReproducibilityBundle, ScientificArtifact,
} from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { TextDownload } from './ArtifactViewer';
import { CodeBlock, ErrorNote, Loading, Markdown, Pill, bytes, digest, roleLabel } from './ui';

export default function ProvenanceInspector({
  artifact,
  sessionId,
  onFork,
  onReplayed,
  onEditInKernel,
  forkBusy,
}: {
  artifact: ScientificArtifact;
  sessionId: string;
  onFork: (id: string) => void;
  onReplayed?: (newArtifactId?: string) => void;
  onEditInKernel?: (code: string, language: 'python' | 'r', artifactId: string) => void;
  forkBusy: boolean;
}) {
  const { locale, L } = useI18n();
  const [manifest, setManifest] = useState<ProvenanceManifest>();
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState<BundleReplayResult>();
  const [bundle, setBundle] = useState<ReproducibilityBundle>();
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.provenance(sessionId, artifact.id, controller.signal).then(value => {
      if (!controller.signal.aborted) setManifest(value);
    }).catch(error => { if (!controller.signal.aborted) setLoadError(errorText(error)); });
    return () => controller.abort();
  }, [sessionId, artifact.id, attempt]);

  async function exportBundle() {
    setExporting(true);
    setExportError('');
    try { setBundle(await api.exportBundle(sessionId, artifact.id)); }
    catch (error) { setExportError(errorText(error)); }
    finally { setExporting(false); }
  }

  async function runReplay(targetManifest: ProvenanceManifest) {
    setReplaying(true);
    setExportError('');
    setReplayResult(undefined);
    try {
      const res = await api.replayBundle(sessionId, { manifest: targetManifest });
      setReplayResult(res.replay);
      onReplayed?.(res.artifact?.id);
    } catch (error) {
      setExportError(errorText(error));
    } finally {
      setReplaying(false);
    }
  }

  async function handleImportManifest(file: File | undefined) {
    if (!file) return;
    setExportError('');
    try {
      const parsed = JSON.parse(await file.text()) as ProvenanceManifest;
      if (!parsed?.executionCode?.code) {
        throw new Error(L('所选 JSON 不是有效的 SciDeveloper 溯源清单文件。', 'Selected JSON is not a valid SciDeveloper provenance_manifest.json file.'));
      }
      await runReplay(parsed);
    } catch (error) {
      setExportError(errorText(error));
    }
  }

  return <section className="stack provenance">
    <div className="artifact-header">
      <div className="min-w-0">
        <h3>{artifact.title}</h3>
        <p className="muted">{L('分析方法与可复现记录', 'Methods & reproducibility record')}</p>
      </div>
    </div>

    {loadError && <>
      <ErrorNote>{loadError}</ErrorNote>
      <button className="btn w-fit" onClick={() => { setLoadError(''); setAttempt(value => value + 1); }}>{L('重试', 'Retry')}</button>
    </>}
    {!manifest && !loadError && <Loading label={L('正在加载分析方法…', 'Loading methods…')} />}

    {manifest && <>
      <div className="soft-card stack">
        <h4>{L('方法摘要', 'Methods summary')}</h4>
        <Markdown text={manifest.plainLanguageSummary} />
        <div className="actions justify-start">
          <button type="button" className="btn btn-primary" disabled={exporting || replaying} onClick={() => void exportBundle()}>
            {exporting ? <Loading label={L('正在打包…', 'Preparing package…')} /> : <><Download size={14} />{L('导出可复现包', 'Export Bundle')}</>}
          </button>
          {manifest.executionCode.language === 'python' && (
            <button type="button" className="btn" disabled={replaying} onClick={() => void runReplay(manifest)}>
              {replaying ? <Loading label={L('复现运行中…', 'Replaying…')} /> : <><PlayCircle size={14} />{L('一键复现验证', 'Replay & Verify')}</>}
            </button>
          )}
          <button type="button" className="btn" disabled={replaying} onClick={() => importRef.current?.click()}>
            <Upload size={14} />{L('导入清单复现', 'Import JSON')}
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={e => { void handleImportManifest(e.target.files?.[0]); e.target.value = ''; }}
          />
        </div>
      </div>

      {exportError && <ErrorNote>{exportError}</ErrorNote>}

      {replayResult && <section className="soft-card stack">
        <div className="card-head">
          <div className="flex items-center gap-2">
            {replayResult.exitCode === 0
              ? <CheckCircle2 size={16} className="text-teal" />
              : <AlertTriangle size={16} className="text-amber" />}
            <strong>{L('复现验证结果', 'Replay Verification')}</strong>
          </div>
          <Pill tone={replayResult.outputSha256Matched ? 'teal' : replayResult.exitCode === 0 ? 'blue' : 'red'}>
            {replayResult.outputSha256Matched ? L('哈希完全一致', 'Exact SHA-256 Match') : replayResult.exitCode === 0 ? L('复现运行成功', 'Re-executed OK') : L('复现失败', 'Replay Failed')}
          </Pill>
        </div>
        <p className="muted">{replayResult.summary}</p>
        <div className="pills">
          <Pill>{L('代码校验：', 'Code hash ')}{replayResult.codeSha256Matched ? L('一致', 'verified') : L('已修改', 'modified')}</Pill>
          <Pill>{replayResult.durationMs} ms</Pill>
          {replayResult.actualOutputSha256 && <Pill title={replayResult.actualOutputSha256}>{L('输出哈希 ', 'Output ')}{digest(replayResult.actualOutputSha256)}</Pill>}
        </div>
      </section>}

      {bundle && <section className="soft-card stack">
        <div className="card-head">
          <strong>{L('可复现包已就绪', 'Package ready')}</strong>
          <Pill tone="teal">{L(`${bundle.files.length} 个文件`, `${bundle.files.length} files`)}</Pill>
        </div>
        <div className="pills">
          <TextDownload name="METHODS.md" content={bundle.methodsMarkdown} />
          <TextDownload name="reproduce.py" content={bundle.reproScript} />
        </div>
        <details className="subtle-details">
          <summary><ChevronDown size={14} />{L('导出目录与文件校验和', 'Saved folder & file checksums')}</summary>
          <div className="stack mt-2">
            <code className="break-all muted">{bundle.exportDir}</code>
            <ul className="stack">{bundle.files.map(file => <li key={file.relativePath}>
              <strong>{file.relativePath || file.name}</strong>
              <div className="hash">{file.sha256}</div>
            </li>)}</ul>
          </div>
        </details>
      </section>}

      <details className="disclosure-card">
        <summary><Code2 size={15} /><span>{L('分析代码', 'Analysis code')}</span><Pill>{manifest.executionCode.language}</Pill>{manifest.executionCode.editedByResearcher && <Pill tone="blue">{L('已编辑', 'Edited')}</Pill>}<ChevronDown size={14} className="disclosure-chevron" /></summary>
        <div className="stack disclosure-body">
          <div className="pills">
            {manifest.executionCode.durationMs != null && <Pill>{manifest.executionCode.durationMs.toLocaleString()} ms</Pill>}
            {manifest.executionCode.exitCode != null && (
              <Pill tone={manifest.executionCode.exitCode === 0 ? 'teal' : 'red'}>
                {manifest.executionCode.exitCode === 0 ? L('执行成功', 'Completed') : L(`退出码 ${manifest.executionCode.exitCode}`, `Exit ${manifest.executionCode.exitCode}`)}
              </Pill>
            )}
            {onEditInKernel && (manifest.executionCode.language === 'python' || manifest.executionCode.language === 'r') && (
              <button
                type="button"
                className="btn"
                style={{ marginLeft: 'auto' }}
                onClick={() => onEditInKernel(manifest.executionCode.code, manifest.executionCode.language as 'python' | 'r', artifact.id)}
              >
                <Code2 size={13} />{L('在内核中编辑并重跑', 'Edit & Run Cell')}
              </button>
            )}
          </div>
          <CodeBlock text={manifest.executionCode.code} language={manifest.executionCode.language} />
          {manifest.executionCode.stdout && <details className="subtle-details"><summary><ChevronDown size={14} />{L('运行输出日志', 'Output log')}</summary><CodeBlock text={manifest.executionCode.stdout} /></details>}
          {manifest.executionCode.stderr && <details className="subtle-details"><summary><ChevronDown size={14} />{L('警告 / 错误信息', 'Warnings / errors')}</summary><CodeBlock text={manifest.executionCode.stderr} /></details>}
        </div>
      </details>

      <details className="disclosure-card">
        <summary><Cpu size={15} /><span>{L('软件与运行环境', 'Software environment')}</span><ChevronDown size={14} className="disclosure-chevron" /></summary>
        <div className="stack disclosure-body">
          <dl className="facts">
            <dt>Python</dt><dd>{manifest.environmentSnapshot.pythonVersion || L('未安装', 'Unavailable')}</dd>
            {manifest.environmentSnapshot.rVersion && <><dt>R</dt><dd>{manifest.environmentSnapshot.rVersion}</dd></>}
            <dt>{L('操作系统', 'System')}</dt><dd>{manifest.environmentSnapshot.platform} · {manifest.environmentSnapshot.arch}</dd>
            <dt>{L('计算环境', 'Compute')}</dt><dd>{manifest.environmentSnapshot.computeTargetId}</dd>
          </dl>
          {Object.keys(manifest.environmentSnapshot.packages).length > 0 && (
            <div className="data-scroll">
              <table>
                <thead><tr><th scope="col">{L('软件包', 'Package')}</th><th scope="col">{L('版本', 'Version')}</th></tr></thead>
                <tbody>
                  {Object.entries(manifest.environmentSnapshot.packages)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, version]) => <tr key={name}><td>{name}</td><td><code>{version}</code></td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="disclosure-card">
        <summary><History size={15} /><span>{L('分析步骤历史', 'Step history')}</span><Pill>{manifest.conversationalLineage.length}</Pill><ChevronDown size={14} className="disclosure-chevron" /></summary>
        <div className="stack disclosure-body">
          <ol className="lineage">
            {manifest.conversationalLineage.map((step, index) => <li key={step.nodeId}>
              <div className="pills"><Pill tone={step.role}>{index + 1}. {roleLabel(step.role, locale)}</Pill><strong>{step.agentName}</strong></div>
              <p>{step.summary}</p>
            </li>)}
          </ol>
          <button className="btn w-fit" disabled={forkBusy} onClick={() => onFork(manifest.nodeId ?? artifact.nodeId)}>
            <GitFork size={14} />{L('从此步骤创建新分支对话', 'Branch research from this step')}
          </button>
        </div>
      </details>

      <details className="disclosure-card">
        <summary><Shield size={15} /><span>{L('文件完整性校验 (SHA-256)', 'Verification checksums')}</span><ChevronDown size={14} className="disclosure-chevron" /></summary>
        <div className="stack disclosure-body">
          <dl className="facts">
            <dt>{L('文件大小', 'File size')}</dt><dd>{bytes(artifact.fileSizeBytes)}</dd>
            <dt>{L('输出 SHA-256', 'Result SHA-256')}</dt><dd className="hash" title={manifest.outputSha256}>{digest(manifest.outputSha256)}…</dd>
            <dt>{L('代码 SHA-256', 'Code SHA-256')}</dt><dd className="hash" title={manifest.executionCode.codeSha256}>{digest(manifest.executionCode.codeSha256)}…</dd>
          </dl>
          {Object.keys(manifest.inputHashes).length > 0 && <div className="stack">
            <strong className="section-label">{L('输入文件', 'Input files')}</strong>
            {Object.entries(manifest.inputHashes).map(([name, hash]) => <div key={name}>
              <span>{name}</span><div className="hash">{hash}</div>
            </div>)}
          </div>}
        </div>
      </details>
    </>}
  </section>;
}
