import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Eye, FileCode2, FileSpreadsheet, FileText, FolderOpen, Paperclip, RefreshCw, Upload,
} from 'lucide-react';
import type { WorkspaceFileEntry, WorkspaceFilePreview } from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { CodeBlock, ErrorNote, Loading, Modal, Pill, bytes } from './ui';

declare global {
  interface Window {
    scideveloperDesktop?: {
      getServerUrl: () => Promise<string>;
      selectWorkspaceDir: () => Promise<string | null>;
      openPath: (targetPath: string) => Promise<string>;
    };
  }
}

function fileIcon(ext: string) {
  if (['csv', 'tsv', 'xlsx', 'parquet'].includes(ext)) return <FileSpreadsheet size={14} />;
  if (['py', 'r', 'json', 'pdb', 'fasta', 'fa', 'vcf', 'sdf', 'mol2', 'h5ad', 'sbatch'].includes(ext)) return <FileCode2 size={14} />;
  return <FileText size={14} />;
}

export default function WorkspaceFilesPanel({
  sessionId,
  workspacePath,
  attachedFiles,
  onToggleAttach,
  onWorkspaceChanged,
  onAnalyzeFile,
}: {
  sessionId?: string;
  workspacePath?: string;
  attachedFiles: string[];
  onToggleAttach: (relativePath: string) => void;
  onWorkspaceChanged: (newPath: string) => Promise<void>;
  onAnalyzeFile: (relativePath: string) => void;
}) {
  const { L } = useI18n();
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<WorkspaceFilePreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState(workspacePath ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPathInput(workspacePath ?? '');
  }, [workspacePath]);

  const loadFiles = useCallback(async () => {
    if (!sessionId) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.workspaceFiles(sessionId);
      setFiles(res.files.filter(f => f.kind === 'file').slice(0, 80));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles, workspacePath]);

  async function chooseFolder() {
    if (!sessionId) return;
    if (window.scideveloperDesktop?.selectWorkspaceDir) {
      const picked = await window.scideveloperDesktop.selectWorkspaceDir();
      if (picked) {
        try {
          await onWorkspaceChanged(picked);
          await loadFiles();
        } catch (cause) {
          setError(errorText(cause));
        }
      }
    } else {
      setEditingPath(v => !v);
    }
  }

  async function applyManualPath() {
    if (!pathInput.trim()) return;
    setError('');
    try {
      await onWorkspaceChanged(pathInput.trim());
      setEditingPath(false);
      await loadFiles();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function handleUploadFiles(fileList: FileList | null) {
    if (!fileList?.length || !sessionId) return;
    setUploading(true);
    setError('');
    try {
      for (const file of Array.from(fileList)) {
        const buffer = await file.arrayBuffer();
        const bytesArr = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytesArr.length; i++) binary += String.fromCharCode(bytesArr[i]);
        const base64 = btoa(binary);
        const uploaded = await api.uploadWorkspaceFile(sessionId, {
          filename: file.name,
          content: base64,
          isBase64: true,
        });
        if (!attachedFiles.includes(uploaded.relativePath)) {
          onToggleAttach(uploaded.relativePath);
        }
      }
      await loadFiles();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setUploading(false);
    }
  }

  async function openPreview(relativePath: string) {
    if (!sessionId) return;
    setPreviewLoading(true);
    setError('');
    try {
      setPreview(await api.previewWorkspaceFile(sessionId, relativePath));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPreviewLoading(false);
    }
  }

  if (!sessionId) {
    return <div className="sidebar-sessions">
      <p className="muted sidebar-empty">{L('开启或打开一个研究对话后，可在此挂载本地数据文件夹或上传实验数据。', 'Start or open a research conversation to mount local datasets and inspect workspace files.')}</p>
    </div>;
  }

  return <div className="sidebar-sessions stack">
    <div className="workspace-folder-bar">
      <div className="min-w-0">
        <div className="sidebar-group-label" style={{ padding: 0 }}>{L('本地工作区', 'Local workspace')}</div>
        <code className="truncate block text-xs muted" title={workspacePath}>{workspacePath ?? L('默认工作区', 'Default workspace')}</code>
      </div>
      <div className="actions">
        <button type="button" className="icon-btn" title={L('更换工作区文件夹', 'Change workspace folder')} aria-label={L('更换工作区文件夹', 'Change workspace folder')} onClick={() => void chooseFolder()}>
          <FolderOpen size={14} />
        </button>
        <button type="button" className="icon-btn" title={L('刷新文件列表', 'Refresh files')} aria-label={L('刷新文件列表', 'Refresh files')} onClick={() => void loadFiles()}>
          <RefreshCw size={14} />
        </button>
      </div>
    </div>

    {editingPath && <div className="stack">
      <input value={pathInput} onChange={e => setPathInput(e.target.value)} placeholder={L('输入本地数据目录的完整路径…', 'Absolute path to dataset folder…')} />
      <div className="actions">
        <button type="button" className="btn" onClick={() => setEditingPath(false)}>{L('取消', 'Cancel')}</button>
        <button type="button" className="btn btn-primary" onClick={() => void applyManualPath()}>{L('挂载目录', 'Mount folder')}</button>
      </div>
    </div>}

    <div
      className={'upload-dropzone' + (dragging ? ' dragging' : '')}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); void handleUploadFiles(e.dataTransfer.files); }}
      onClick={() => fileInputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".csv,.tsv,.xlsx,.pdf,.h5ad,.parquet,.vcf,.sdf,.mol2,.json,.pdb,.fasta,.fa,.txt,.md"
        style={{ display: 'none' }}
        onChange={e => { void handleUploadFiles(e.target.files); e.target.value = ''; }}
      />
      <Upload size={16} />
      <span>{uploading ? L('正在上传数据文件…', 'Uploading dataset…') : L('拖拽或点击上传 CSV / XLSX / PDF / H5AD / PDB', 'Drop CSV / XLSX / PDF / VCF / H5AD / PDB or click')}</span>
    </div>

    {error && <ErrorNote>{error}</ErrorNote>}
    {loading && <Loading label={L('正在扫描工作区…', 'Scanning workspace…')} />}
    {previewLoading && <Loading label={L('正在加载预览…', 'Loading preview…')} />}

    <div className="file-tree-list">
      {files.map(file => {
        const attached = attachedFiles.includes(file.relativePath);
        return <div key={file.relativePath} className={'file-row' + (attached ? ' attached' : '')}>
          <button type="button" className="file-row-main" onClick={() => void openPreview(file.relativePath)} title={file.relativePath}>
            {fileIcon(file.extension)}
            <span className="truncate">{file.relativePath}</span>
          </button>
          <span className="file-size">{bytes(file.sizeBytes)}</span>
          <button
            type="button"
            className={'icon-btn file-action' + (attached ? ' active' : '')}
            title={attached ? L('从提问中移除', 'Detach from prompt') : L('附加到下次提问', 'Attach to next prompt')}
            aria-label={attached ? L('移除文件', 'Detach file') : L('附加文件', 'Attach file')}
            onClick={() => onToggleAttach(file.relativePath)}
          >
            <Paperclip size={13} />
          </button>
        </div>;
      })}
      {!loading && !files.length && <p className="muted sidebar-empty">{L('暂无数据文件，可上传 CSV/Excel 或挂载本地文件夹。', 'No data files yet. Upload a CSV or mount your project folder.')}</p>}
    </div>

    {preview && <Modal title={preview.relativePath} subtitle={`${preview.format.toUpperCase()} · ${bytes(preview.sizeBytes)}`} size="lg" onClose={() => setPreview(undefined)}>
      <div className="stack">
        <div className="actions justify-start">
          <button type="button" className="btn btn-primary" onClick={() => { onAnalyzeFile(preview.relativePath); setPreview(undefined); }}>
            <Eye size={14} />{L('立即分析该数据集', 'Analyze this dataset now')}
          </button>
          <button type="button" className="btn" onClick={() => { onToggleAttach(preview.relativePath); setPreview(undefined); }}>
            <Paperclip size={14} />{attachedFiles.includes(preview.relativePath) ? L('从提问中移除', 'Detach from prompt') : L('附加到提问', 'Attach to prompt')}
          </button>
        </div>
        {preview.headers && preview.rows ? (
          <div className="data-scroll">
            <table>
              <thead><tr>{preview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{preview.rows.slice(0, 25).map((r, i) => <tr key={i}>{preview.headers!.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
            </table>
          </div>
        ) : (
          <CodeBlock text={preview.previewText} language={preview.format === 'json' ? 'json' : undefined} />
        )}
        <div className="pills">
          <Pill>{preview.totalLines ? L(`${preview.totalLines.toLocaleString()} 行`, `${preview.totalLines.toLocaleString()} lines`) : preview.format.toUpperCase()}</Pill>
          {preview.sheets?.length ? <Pill tone="blue">{L('工作表：', 'Sheets: ')}{preview.sheets.join(', ')}</Pill> : null}
          {preview.pageCount ? <Pill tone="blue">{L(`${preview.pageCount} 页`, `${preview.pageCount} pages`)}</Pill> : null}
          {preview.structuredMetadata && Object.entries(preview.structuredMetadata).slice(0, 4).map(([k, v]) => (
            <Pill key={k}>{k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}</Pill>
          ))}
          <Pill tone="teal">{L('沙箱只读保护', 'Read-only protected')}</Pill>
        </div>
      </div>
    </Modal>}
  </div>;
}
