// ui/src/components/FileTree.tsx —— 文件 Tab：工作区切换 + 文件树浏览 + 文件预览
import { useCallback, useEffect, useState } from 'react';
import { fileApi, workspacesApi } from '../api';
import { IconFolder } from './Icon';
import type { WorkspaceInfo } from '../types';

interface TreeEntry { name: string; type: 'dir' | 'file'; size: number }

function TreeNode({ entry, path, depth, onOpenFile }: {
  entry: TreeEntry; path: string; depth: number;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const rel = path === '.' ? entry.name : `${path}/${entry.name}`;

  const toggle = useCallback(async () => {
    if (entry.type !== 'dir') return;
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      try {
        const r = await fileApi.tree(rel);
        setChildren(r.entries);
      } catch { setChildren([]); }
    }
  }, [entry.type, open, children, rel]);

  if (entry.type === 'dir') {
    return (
      <div>
        <div className={`tree-node tree-dir`} style={{ paddingLeft: depth * 14 + 6 }} onClick={() => void toggle()}>
          <span className="tree-caret">{open ? '▾' : '▸'}</span><IconFolder size={13} /> {entry.name}
        </div>
        {open && children && children.map((c) => (
          <TreeNode key={c.name} entry={c} path={rel} depth={depth + 1} onOpenFile={onOpenFile} />
        ))}
      </div>
    );
  }
  return (
    <div className="tree-node tree-file" style={{ paddingLeft: depth * 14 + 20 }} onClick={() => onOpenFile(rel)} title={rel}>
      📄 {entry.name}
    </div>
  );
}

export default function FileTree() {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [roots, setRoots] = useState<TreeEntry[] | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
    try {
      await workspacesApi.add(path.trim());
      await loadWorkspaces();
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const removeWs = async (id: string) => {
    if (!confirm('移除该工作区？（不会删除磁盘文件）')) return;
    try {
      await workspacesApi.remove(id);
      await loadWorkspaces();
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  const openFile = async (rel: string) => {
    try {
      const r = await fileApi.read(rel);
      setPreview({ path: rel, text: r.text });
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="file-panel">
      <div className="provider-hint">工作区 = Agent 文件工具沙箱边界，切换立即生效</div>
      <div className="ws-row">
        <select
          className="ws-select"
          value={current}
          onChange={(e) => void switchWs(e.target.value)}
          title="切换工作区"
        >
          {workspaces.length === 0 && <option value="">（无工作区）</option>}
          {workspaces.map((w) => <option key={w.id} value={w.path}>{w.path}</option>)}
        </select>
        <button className="ws-btn" onClick={() => void addWs()} title="添加工作区">＋</button>
        {workspaces.find((w) => w.path === current) && (
          <button className="ws-btn danger" onClick={() => void removeWs(workspaces.find((w) => w.path === current)!.id)} title="移除当前工作区">✕</button>
        )}
      </div>
      {msg && <div className="provider-msg err">{msg}</div>}
      {current && <div className="tree-root">沙箱根：{current}</div>}
      <div className="tree-list">
        {roots === null && <div className="empty-hint">加载中…</div>}
        {roots?.length === 0 && <div className="empty-hint">空目录</div>}
        {roots?.map((e) => <TreeNode key={e.name} entry={e} path="." depth={0} onOpenFile={openFile} />)}
      </div>
      {preview && (
        <div className="file-preview">
          <div className="file-preview-head">
            <span className="file-preview-path">{preview.path}</span>
            <button className="ws-btn" onClick={() => setPreview(null)}>✕</button>
          </div>
          <pre className="file-preview-body">{preview.text}</pre>
        </div>
      )}
    </div>
  );
}
