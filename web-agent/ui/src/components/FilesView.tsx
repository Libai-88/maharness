// ui/src/components/FilesView.tsx —— 文件工作区（Screen 2）：工作区 + 文件树 + 代码查看器 + Git 面板
// 全部交互真实接线：搜索/编辑保存/关闭全屏/工作区切换/Git 状态提交推送
import { useCallback, useEffect, useRef, useState } from 'react';
import { fileApi, gitApi, workspacesApi } from '../api';
import type { GitStatus } from '../api';
import { IconBox, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconExpand, IconFileText, IconFolder, IconGitBranch, IconPlus, IconRefresh, IconSearch, IconSync } from './Icon';

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
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-label={`目录 ${entry.name}`}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggle(); } }}
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
      role="button"
      tabIndex={0}
      aria-selected={isSel}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(rel); onOpenFile(rel); } }}
    >
      <span className="ti-icon" style={{ color: 'var(--text-4)', display: 'inline-flex' }}><IconFileText size={12} /></span>
      {entry.name}
      {entry.name.endsWith('.ts') && <span className="ti-badge m">M</span>}
    </div>
  );
}

const GIT_STATUS_LABEL: Record<string, { icon: string; cls: string }> = {
  M: { icon: 'M', cls: 'm' },
  A: { icon: 'A', cls: 'a' },
  D: { icon: 'D', cls: 'd' },
  R: { icon: 'R', cls: 'a' },
  '??': { icon: 'U', cls: 'a' },
};

/** Git 变更面板：真实状态 / 提交 / 推送 / 点击变更在查看器打开 */
function GitPanel({ onOpen }: { onOpen: (path: string) => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okTip, setOkTip] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await gitApi.status()); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const tip = (t: string | null) => { setOkTip(t); if (t) setTimeout(() => setOkTip(null), 3000); };

  const commit = async () => {
    const m = msg.trim();
    if (!m || !status?.repo || busy) return;
    setBusy(true); setErr(null);
    try {
      await gitApi.commit(m);
      setMsg('');
      await load();
      tip('已提交');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const push = async () => {
    if (!status?.repo || busy) return;
    setBusy(true); setErr(null);
    try {
      await gitApi.push();
      await load();
      tip('已推送');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const items = [
    ...(status?.staged ?? []).map((c) => ({ ...c, staged: true })),
    ...(status?.changes ?? []).map((c) => ({ ...c, staged: false })),
  ];

  return (
    <aside className="git-panel">
      <div className="git-head">
        <span className="gh-title"><span style={{ color: 'var(--teal)' }}>Y</span> SOURCE CONTROL</span>
        {status?.repo && <span className="gh-count">{items.length}</span>}
      </div>
      <div className="git-branch">
        <span className="gb-name"><span className="gb-icon"><IconGitBranch size={10} /></span>
          {status?.repo ? `${status.branch || '(no branch)'}${status.ahead ? ` · ${status.ahead} ahead` : ''}` : '非 git 仓库'}
        </span>
        <button className="manager-close" title="刷新" aria-label="刷新" onClick={() => void load()}><IconSync size={13} /></button>
      </div>
      <div className="git-scroll">
        {!status && <div className="empty-state" style={{ padding: '20px 12px' }}>加载中…</div>}
        {status?.repo && items.length === 0 && <div className="empty-state" style={{ padding: '20px 12px' }}><IconCheck size={13} /> 工作区干净</div>}
        {status?.repo && items.length > 0 && (
          <>
            <div className="git-section">CHANGES <span className="gs-count">· {items.length}</span></div>
            {items.map((c, i) => {
              const g = GIT_STATUS_LABEL[c.status] ?? { icon: c.status, cls: 'm' };
              return (
                <div
                  key={`${c.path}-${i}`}
                  className="git-change"
                  role="button"
                  tabIndex={0}
                  title={`查看 ${c.path}`}
                  onClick={() => onOpen(c.path)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(c.path); } }}
                >
                  <span className={`gc-icon ${g.cls}`}>{g.icon}</span>
                  <span className="gc-name">{c.path}</span>
                </div>
              );
            })}
          </>
        )}
        {err && <div style={{ padding: 10, fontSize: 11, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{err}</div>}
      </div>
      <div className="git-commit-box">
        {okTip && <div style={{ fontSize: 11, color: 'var(--teal)', fontFamily: 'var(--font-mono)' }}>{okTip}</div>}
        <input
          className="gcb-input"
          placeholder={status?.repo ? '提交信息…' : '沙箱不是 git 仓库'}
          value={msg}
          disabled={!status?.repo || busy}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commit(); } }}
        />
        <span className="gcb-hint">Enter 提交 · 全部变更 add -A</span>
        <div className="gcb-actions">
          <button className="gcb-push" onClick={() => void push()} disabled={!status?.repo || busy || !status.ahead}>
            {busy && !msg.trim() ? <span className="spin" /> : null}推送 ↑
          </button>
          <button className="gcb-commit" onClick={() => void commit()} disabled={!status?.repo || busy || !msg.trim()}>
            {busy && msg.trim() ? <span className="spin" /> : null}提交 <IconCheck size={12} />
          </button>
        </div>
      </div>
    </aside>
  );
}

export default function FilesView() {
  const [current, setCurrent] = useState<string>('');
  const [workspaces, setWorkspaces] = useState<{ id: string; path: string }[]>([]);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [newWsPath, setNewWsPath] = useState('');
  const [roots, setRoots] = useState<TreeEntry[] | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [selected, setSelected] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<{ path: string; size: number }[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saveTip, setSaveTip] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const wsInputRef = useRef<HTMLInputElement>(null);
  const wsWrapRef = useRef<HTMLDivElement>(null);

  // 工作区下拉：点击外部 / Escape 关闭（与顶栏 Menu 行为一致）
  useEffect(() => {
    if (!wsMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wsWrapRef.current && !wsWrapRef.current.contains(e.target as Node)) setWsMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWsMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [wsMenuOpen]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const ws = await workspacesApi.list();
      setWorkspaces(ws);
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
  useEffect(() => { if (searching) searchRef.current?.focus(); }, [searching]);
  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing]);

  // 搜索（防抖 250ms）
  useEffect(() => {
    if (!searching) return;
    const q = searchQ.trim();
    if (!q) { setSearchResults(null); return; }
    const t = setTimeout(() => {
      fileApi.search(q).then((r) => setSearchResults(r.results)).catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [searchQ, searching]);

  const switchWs = async (path: string) => {
    if (path === current) return;
    try {
      await workspacesApi.switchTo(path);
      setCurrent(path);
      await loadWorkspaces();
      setWsMenuOpen(false);
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const addWs = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    try {
      await workspacesApi.add(p);
      await loadWorkspaces();
      setNewWsPath('');
      setMsg(null);
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const openFile = async (rel: string) => {
    try {
      const r = await fileApi.read(rel);
      setPreview({ path: rel, text: r.text });
      setSelected(rel);
      setEditing(false);
      setMsg(null);
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const saveFile = async () => {
    if (!preview || !editing) return;
    try {
      await fileApi.write(preview.path, draft);
      setPreview({ path: preview.path, text: draft });
      setEditing(false);
      setSaveTip(`已保存 ${preview.path}`);
      setTimeout(() => setSaveTip(null), 2500);
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const lines = (editing ? draft : preview?.text ?? '').split('\n');

  return (
    <div className="files-layout">
      <div className="file-tree-pane">
        <div className="ft-head">EXPLORER</div>
        <div className="ws-menu-wrap" ref={wsWrapRef}>
          <div
            className="ws-picker"
            onClick={() => { setWsMenuOpen((v) => !v); if (!wsMenuOpen) setTimeout(() => wsInputRef.current?.focus(), 30); }}
            role="button"
            tabIndex={0}
            aria-expanded={wsMenuOpen}
            aria-haspopup="menu"
            aria-label="切换工作区"
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWsMenuOpen((v) => !v); } if (e.key === 'Escape') setWsMenuOpen(false); }}
          >
            <div className="ws-picker-left">
              <span className="ws-picker-icon"><IconBox size={13} /></span>
              <div>
                <div className="ws-picker-name">{current.split(/[\\/]/).pop() || '选择工作区…'}</div>
                <div className="ws-picker-path">{current || '选择工作区…'}</div>
              </div>
            </div>
            <span style={{ color: 'var(--text-4)', display: 'inline-flex', transition: 'transform .15s', transform: wsMenuOpen ? 'none' : 'rotate(-90deg)' }}><IconChevronDown size={11} /></span>
          </div>
          {wsMenuOpen && (
            <div className="ws-menu" role="menu" aria-label="工作区列表">
              <div className="ws-menu-title">工作区</div>
              {workspaces.length === 0 && <div className="menu-empty">暂无工作区</div>}
              {workspaces.map((w) => (
                <div
                  key={w.id}
                  className={`ws-menu-item ${w.path === current ? 'current' : ''}`}
                  role="menuitem"
                  tabIndex={0}
                  onClick={() => void switchWs(w.path)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void switchWs(w.path); } }}
                  title={w.path}
                >
                  <span className="wsi-name">{w.path.split(/[\\/]/).pop() || w.path}</span>
                  <span className="wsi-path">{w.path}</span>
                  {w.path === current && <IconCheck size={12} />}
                </div>
              ))}
              <div className="ws-menu-add">
                <input
                  ref={wsInputRef}
                  placeholder="添加目录（绝对路径）…"
                  value={newWsPath}
                  onChange={(e) => setNewWsPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addWs(newWsPath);
                    if (e.key === 'Escape') setWsMenuOpen(false);
                    e.stopPropagation();
                  }}
                  aria-label="添加工作区目录路径"
                />
                <button className="ft-tool" style={{ height: 28 }} onClick={() => void addWs(newWsPath)} title="添加工作区" aria-label="添加工作区"><IconPlus size={13} /></button>
              </div>
            </div>
          )}
        </div>
        <div className="ft-tools">
          <button className="ft-tool" onClick={() => void loadRoot()} title="刷新" aria-label="刷新"><IconRefresh size={13} /></button>
          <button className={`ft-tool ${searching ? 'active' : ''}`} onClick={() => { setSearching((v) => !v); setSearchQ(''); setSearchResults(null); }} title="搜索文件" aria-label="搜索文件"><IconSearch size={13} /></button>
        </div>
        <div className="tree-scroll">
          {searching && (
            <div className="search-box">
              <input
                ref={searchRef}
                className="search-input"
                placeholder="搜索文件名…"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setSearching(false); setSearchQ(''); setSearchResults(null); } }}
              />
              {searchResults !== null && (
                <div className="search-results">
                  {searchResults.length === 0 && <div className="empty-state" style={{ padding: '12px 8px' }}>无匹配文件</div>}
                  {searchResults.map((r) => (
                    <div
                      key={r.path}
                      className="search-result"
                      onClick={() => void openFile(r.path)}
                      title={r.path}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openFile(r.path); } }}
                    >
                      <IconFileText size={11} />
                      <span className="sr-path">{r.path}</span>
                      <span className="sr-size">{r.size >= 1024 ? `${(r.size / 1024).toFixed(0)}k` : `${r.size}B`}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!searching && roots === null && <div className="empty-state">加载中…</div>}
          {!searching && roots?.length === 0 && <div className="empty-state">空目录</div>}
          {!searching && roots?.map((e) => <TreeNode key={e.name} entry={e} path="." depth={0} onOpenFile={openFile} selected={selected} onSelect={setSelected} />)}
          {msg && <div style={{ padding: 12, fontSize: 12, color: 'var(--red)' }}>{msg}</div>}
        </div>
      </div>

      <div className={`file-viewer ${fullscreen ? 'fullscreen' : ''}`}>
        <div className="viewer-breadcrumb">
          <div className="vb-path">
            <span className="f">{current.split(/[\\/]/).pop()}</span>
            {preview && (<><span className="sep">/</span><span className="cur">{preview.path}</span></>)}
            {!preview && <span className="cur" style={{ color: 'var(--text-4)' }}>选择文件预览</span>}
          </div>
          <div className="vb-right">
            <button className="vb-btn" title="在资源管理器中打开" aria-label="在资源管理器中打开" onClick={() => { if (preview) void fileApi.open(preview.path); }}><IconBox size={12} /></button>
            <button className="vb-btn" title="全屏" aria-label="全屏" onClick={() => setFullscreen((v) => !v)}><IconExpand size={12} /></button>
            <button className="vb-btn" title="关闭" aria-label="关闭" onClick={() => { setPreview(null); setSelected(''); setEditing(false); }}><IconClose size={12} /></button>
            {preview && !editing && <button className="vb-save" onClick={() => { setDraft(preview.text); setEditing(true); }}>编辑</button>}
            {preview && editing && (
              <>
                <button className="vb-save" onClick={() => void saveFile()} disabled={draft === preview.text}>保存 ⌃S</button>
                <button className="vb-btn" onClick={() => setEditing(false)}>取消</button>
              </>
            )}
          </div>
        </div>
        <div className="viewer-tabs">
          <div className="v-tab active">
            <span className="vtd" />{preview?.path.split('/').pop() ?? 'untitled'}
            {preview && (
              <button
                className="vtx"
                title="关闭文件"
                aria-label="关闭文件"
                onClick={() => { setPreview(null); setSelected(''); setEditing(false); }}
              ><IconClose size={11} /></button>
            )}
          </div>
        </div>
        {saveTip && <div className="save-tip"><IconCheck size={12} /> {saveTip}</div>}
        <div className="code-viewer">
          {preview ? (
            editing ? (
              <textarea
                ref={editRef}
                className="code-editor"
                value={draft}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void saveFile(); }
                }}
              />
            ) : (
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
            )
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
          <span>Ln {lines.length || 0}</span>
          <span className="vs-sep" />
          <span className="vs-bold"><IconCheck size={11} /> 文件服务就绪</span>
        </div>
      </div>

      <GitPanel onOpen={openFile} />
    </div>
  );
}
