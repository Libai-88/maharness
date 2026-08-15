// ui/src/components/FilesView.tsx —— 文件工作区（Screen 2）：工作区 + 文件树 + 代码查看器 + Git 面板
import { useCallback, useEffect, useState } from 'react';
import { fileApi, workspacesApi } from '../api';
import { IconBox, IconCheck, IconChevronRight, IconClose, IconExpand, IconFileText, IconFolder, IconGitBranch, IconMore, IconPlus, IconRefresh, IconSearch, IconSync } from './Icon';

interface TreeEntry { name: string; type: 'dir' | 'file'; size: number }

function TreeNode({ entry, path, depth, onOpenFile, selected, onSelect }: {
  entry: TreeEntry; path: string; depth: number;
  onOpenFile: (path: string) => void;
  selected: string; onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const rel = path === '.' ? entry.name : `${path}/${entry.name}`;

  const toggle = useCallback(async () => {
    if (entry.type !== 'dir') return;
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      try { const r = await fileApi.tree(rel); setChildren(r.entries); } catch { setChildren([]); }
    }
  }, [entry.type, open, children, rel]);

  if (entry.type === 'dir') {
    return (
      <>
        <div
          className={`tree-item dir ${open ? 'open' : ''}`}
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => void toggle()}
        >
          <span className="ti-chev" style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}><IconChevronRight size={10} /></span>
          <span className="ti-icon"><IconFolder size={13} /></span>
          {entry.name}
        </div>
        {open && children && children.map((c) => (
          <TreeNode key={c.name} entry={c} path={rel} depth={depth + 1} onOpenFile={onOpenFile} selected={selected} onSelect={onSelect} />
        ))}
      </>
    );
  }
  const isSel = selected === rel;
  return (
    <div
      className={`tree-item ${isSel ? 'selected' : ''}`}
      style={{ paddingLeft: depth * 14 + 20 }}
      onClick={() => { onSelect(rel); onOpenFile(rel); }}
      title={rel}
    >
      <span className="ti-icon" style={{ color: 'var(--text-4)', display: 'inline-flex' }}><IconFileText size={12} /></span>
      {entry.name}
      {entry.name.endsWith('.ts') && <span className="ti-badge m">M</span>}
    </div>
  );
}

/** Git 变更面板（展示性 UI） */
function GitPanel() {
  const changes = [
    { icon: 'M', cls: 'm', name: 'PluginLoader.ts', stat: '+12' },
    { icon: 'A', cls: 'a', name: 'plugins/clock/index.ts', stat: '+28' },
    { icon: 'M', cls: 'm', name: 'Cache.ts', stat: '+5 -2', dim: true },
    { icon: 'D', cls: 'd', name: 'legacy/fsWatcher.ts', dim: true },
  ];
  return (
    <aside className="git-panel">
      <div className="git-head">
        <span className="gh-title"><span style={{ color: 'var(--teal)' }}>Y</span> SOURCE CONTROL</span>
        <span className="gh-count">4</span>
      </div>
      <div className="git-branch">
        <span className="gb-name"><span className="gb-icon"><IconGitBranch size={10} /></span>main · 3 ahead</span>
        <button className="manager-close" title="同步" aria-label="同步"><IconSync size={13} /></button>
      </div>
      <div className="git-scroll">
        <div className="git-section">STAGED <span className="gs-count">· 2</span></div>
        {changes.slice(0, 2).map((c) => (
          <div key={c.name} className="git-change">
            <span className={`gc-icon ${c.cls}`}>{c.icon}</span>
            <span className="gc-name">{c.name}</span>
            <span className="gc-stat">{c.stat}</span>
          </div>
        ))}
        <div className="git-section">CHANGES <span className="gs-count">· 2</span></div>
        {changes.slice(2).map((c) => (
          <div key={c.name} className="git-change">
            <span className={`gc-icon ${c.cls}`}>{c.icon}</span>
            <span className="gc-name">{c.name}</span>
            {c.stat && <span className={`gc-stat ${c.dim ? 'dim' : ''}`}>{c.stat}</span>}
          </div>
        ))}
      </div>
      <div className="git-commit-box">
        <input className="gcb-input" defaultValue="feat(plugin): hot-reload via chokidar" />
        <span className="gcb-hint">Ctrl + Enter to commit</span>
        <div className="gcb-actions">
          <button className="gcb-push">推送 ↑</button>
          <button className="gcb-commit">提交 ✓</button>
        </div>
      </div>
    </aside>
  );
}

export default function FilesView() {
  const [current, setCurrent] = useState<string>('');
  const [roots, setRoots] = useState<TreeEntry[] | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [selected, setSelected] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    try {
      const ws = await workspacesApi.list();
      const cur = ws.find((w) => w.current);
      setCurrent(cur?.path ?? ws[0]?.path ?? '');
    } catch { /* 忽略 */ }
  }, []);

  const loadRoot = useCallback(async () => {
    try {
      const r = await fileApi.tree('.');
      setRoots(r.entries);
      setPreview(null);
      setMsg(null);
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  }, []);

  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);
  useEffect(() => { if (current) void loadRoot(); }, [current, loadRoot]);

  const switchWs = async (path: string) => {
    if (path === current) return;
    try {
      await workspacesApi.switchTo(path);
      setCurrent(path);
      await loadWorkspaces();
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const addWs = async () => {
    const path = prompt('添加工作区目录（绝对路径）');
    if (!path?.trim()) return;
    try { await workspacesApi.add(path.trim()); await loadWorkspaces(); } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const openFile = async (rel: string) => {
    try {
      const r = await fileApi.read(rel);
      setPreview({ path: rel, text: r.text });
      setSelected(rel);
      setMsg(null);
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const lines = preview?.text.split('\n') ?? [];

  return (
    <div className="files-layout">
      <div className="file-tree-pane">
        <div className="ft-head">EXPLORER</div>
        <div className="ws-picker" onClick={() => void switchWs(prompt('切换工作区（绝对路径）') ?? current)}>
          <div className="ws-picker-left">
            <span className="ws-picker-icon"><IconBox size={13} /></span>
            <div>
              <div className="ws-picker-name">{current.split(/[\\/]/).pop() || 'DEEPSEEK'}</div>
              <div className="ws-picker-path">{current || '选择工作区…'}</div>
            </div>
          </div>
          <span style={{ color: 'var(--text-4)', fontSize: 10 }}>▾</span>
        </div>
        <div className="ft-tools">
          <button className="ft-tool" onClick={() => void addWs()} title="添加工作区" aria-label="添加工作区"><IconPlus size={13} /></button>
          <button className="ft-tool" onClick={() => void loadRoot()} title="刷新" aria-label="刷新"><IconRefresh size={13} /></button>
          <button className="ft-tool" title="搜索" aria-label="搜索"><IconSearch size={13} /></button>
          <button className="ft-tool" title="更多" aria-label="更多" style={{ marginLeft: 'auto' }}><IconMore size={13} /></button>
        </div>
        <div className="tree-scroll">
          {roots === null && <div className="empty-state">加载中…</div>}
          {roots?.length === 0 && <div className="empty-state">空目录</div>}
          {roots?.map((e) => <TreeNode key={e.name} entry={e} path="." depth={0} onOpenFile={openFile} selected={selected} onSelect={setSelected} />)}
          {msg && <div style={{ padding: 12, fontSize: 12, color: 'var(--red)' }}>{msg}</div>}
        </div>
      </div>

      <div className="file-viewer">
        <div className="viewer-breadcrumb">
          <div className="vb-path">
            <span className="f">{current.split(/[\\/]/).pop()}</span>
            {preview && (<><span className="sep">/</span><span className="cur">{preview.path}</span></>)}
            {!preview && <span className="cur" style={{ color: 'var(--text-4)' }}>选择文件预览</span>}
          </div>
          <div className="vb-right">
            <button className="vb-btn" title="关闭" aria-label="关闭"><IconClose size={12} /></button>
            <button className="vb-btn" title="全屏" aria-label="全屏"><IconExpand size={12} /></button>
            <button className="vb-save">保存 ⌃S</button>
          </div>
        </div>
        <div className="viewer-tabs">
          <div className="v-tab active"><span className="vtd" />{preview?.path.split('/').pop() ?? 'untitled.ts'}<IconClose size={11} /></div>
          <div className="v-tab"><span className="vtd clean" />Cache.ts<IconClose size={11} /></div>
        </div>
        <div className="code-viewer">
          {preview ? (
            <>
              <div className="code-lines">
                {lines.map((_, i) => <span key={i} className={`ln ${i === 4 ? 'hot' : ''}`}>{i + 1}</span>)}
              </div>
              <pre className="code-content">
                {lines.map((line, i) => (
                  <span key={i} className={`line ${i === 4 ? 'diff-add' : ''} ${line.trimStart().startsWith('//') ? 'cm' : ''}`}>{line}</span>
                ))}
              </pre>
            </>
          ) : (
            <div className="empty-state" style={{ flex: 1 }}>← 在左侧文件树中选择文件查看内容</div>
          )}
        </div>
        <div className="viewer-status">
          <span className="vs-bold">main</span>
          <span className="vs-sep" />
          <span>UTF-8</span>
          <span className="vs-sep" />
          <span>{preview ? (preview.path.endsWith('.ts') ? 'TypeScript' : 'Text') : '—'}</span>
          <span className="vs-sep" />
          <span>Ln {lines.length ? 5 : 0}, Col 48</span>
          <span className="vs-sep" />
          <span className="vs-bold"><IconCheck size={11} /> chokidar 监听器已就绪</span>
        </div>
      </div>

      <GitPanel />
    </div>
  );
}
