// ui/src/components/PluginsView.tsx —— 插件面板（Screen 4）：列表 + 详情 + 插件贡献的面板 + 现场热加载指南
import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { pluginsApi } from '../api';
import type { PluginInfo } from '../types';
import { IconCheck, IconClose } from './Icon';
import TodoBoardView from './TodoBoardView';

interface Props {
  plugins: PluginInfo[];
  onAction: (id: string, action: 'enable' | 'disable' | 'reload') => Promise<void> | void;
}

const ICON_COLORS = ['#82a873', '#d0856b', '#e0913f', '#d9a441', '#d96856', '#6b6053'];

/** 插件贡献的前端面板（前端是插件的一部分：插件通过 api 能力提供 GET /panel → { title, html }） */
function PluginPanel({ pluginId }: { pluginId: string }) {
  const [panel, setPanel] = useState<{ title: string; html: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPanel(null);
    setErr(null);
    fetch(`/api/plugins/${pluginId}/panel`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive && d?.html) setPanel(d); })
      .catch(() => { if (alive) setErr('该插件未提供面板'); });
    return () => { alive = false; };
  }, [pluginId]);

  if (err) return null;
  if (!panel) return <div className="pd-manifest"><span className="pm-title">PLUGIN PANEL</span><span className="sd-desc" style={{ color: 'var(--text-3)' }}>加载面板…</span></div>;
  return (
    <div className="pd-manifest">
      <span className="pm-title">PLUGIN PANEL · {panel.title}</span>
      <div className="plugin-panel-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(panel.html) }} />
    </div>
  );
}

export default function PluginsView({ plugins, onAction }: Props) {
  const [selected, setSelected] = useState<PluginInfo | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // 当选中项被停用时清除
  useEffect(() => {
    if (selected) {
      const cur = plugins.find((p) => p.id === selected.id);
      if (cur) setSelected(cur);
    }
  }, [plugins]); // eslint-disable-line

  const act = async (id: string, action: 'enable' | 'disable' | 'reload') => {
    if (busy[id]) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try { await onAction(id, action); } finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const kw = q.trim().toLowerCase();
  const match = (p: PluginInfo) => !kw || p.name.toLowerCase().includes(kw) || (p.caps?.some((c) => c.toLowerCase().includes(kw)) ?? false) || (p.error ?? '').toLowerCase().includes(kw);

  const running = plugins.filter((p) => (p.state === 'started' || p.state === 'loaded') && match(p));
  const stopped = plugins.filter((p) => !(p.state === 'started' || p.state === 'loaded') && match(p));
  const none = kw !== '' && running.length === 0 && stopped.length === 0;

  const renderCard = (p: PluginInfo, idx: number) => {
    const isRun = p.state === 'started' || p.state === 'loaded';
    const stateLabel = isRun ? '运行中' : p.state === 'error' ? '出错' : '已停止';
    const color = ICON_COLORS[idx % ICON_COLORS.length];
    return (
      <div
        key={p.id}
        className={`plugin-card ${isRun ? '' : 'stopped'} ${selected?.id === p.id ? 'selected' : ''}`}
        onClick={() => setSelected(p)}
        role="button"
        tabIndex={0}
        aria-pressed={selected?.id === p.id}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(p); } }}
      >
        <span className="plugin-icon" style={{ background: `${color}26`, color }}>{p.name[0]?.toUpperCase()}</span>
        <div className="plugin-info">
          <div className="plugin-info-top">
            <span className="plugin-name">{p.name}</span>
            <span className="plugin-ver">v{p.version}</span>
            <span className="plugin-tag hot">热重载</span>
            {p.error && <span className="plugin-tag" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}>错误</span>}
          </div>
          <span className="plugin-desc">{p.caps?.join(' · ') || p.error || '插件（能力注册于 PluginLoader）'}</span>
        </div>
        <div className="plugin-right">
          <span className={`plugin-status ${isRun ? 'running' : p.error ? 'error' : 'stopped-s'}`}>
            <span className="ps-dot" />{stateLabel}
          </span>
          <button
            className={`toggle ${isRun ? 'on' : ''}`}
            role="switch"
            aria-checked={isRun}
            aria-label={`${isRun ? '停用' : '启用'}插件 ${p.name}`}
            disabled={!!busy[p.id]}
            onClick={(e) => { e.stopPropagation(); void act(p.id, isRun ? 'disable' : 'enable'); }}
            title={isRun ? '停用' : '启用'}
          >
            <span className="knob" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="plugins-layout">
      <div className="plugins-list">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span className="page-title">插件管理</span>
          <span className="msg-tag">{plugins.length} 个插件</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <input className="set-input" style={{ width: 180, height: 32 }} placeholder="搜索插件…" value={q} onChange={(e) => setQ(e.target.value)} />
          </span>
        </div>
        <div className="plugin-group">运行中 · {running.length}</div>
        {running.map((p, i) => renderCard(p, i))}
        {none && <div className="empty-state" style={{ padding: '24px 12px' }}>没有匹配「{q.trim()}」的插件</div>}
        {stopped.length > 0 && (
          <>
            <div className="plugin-group" style={{ marginTop: 12 }}>已停止 · {stopped.length}</div>
            {stopped.map((p, i) => renderCard(p, running.length + i))}
          </>
        )}
      </div>

      <aside className="manager-panel">
        <div className="manager-head">
          <span className="manager-title">插件详情</span>
          <button className="manager-close" onClick={() => setSelected(null)} aria-label="关闭详情"><IconClose size={13} /></button>
        </div>
        <div className="manager-body">
          {selected ? (
            <>
              <div className="plugin-detail-card">
                <span className="pd-icon" style={{ background: `${ICON_COLORS[plugins.findIndex((p) => p.id === selected.id) % ICON_COLORS.length] || '#3a4350'}26`, color: ICON_COLORS[plugins.findIndex((p) => p.id === selected.id) % ICON_COLORS.length] || '#3a4350' }}>
                  {selected.name[0]?.toUpperCase()}
                </span>
                <span className="pd-name">{selected.name}</span>
                <span className="pd-ver">v{selected.version}</span>
                <div className="pd-status">
                  <span className="ps-dot" style={{ background: 'currentColor' }} />
                  {(selected.state === 'started' || selected.state === 'loaded') ? '运行中 · 热重载已启用' : selected.state === 'error' ? '出错' : '已停止'}
                </div>
                <div className="pd-actions">
                  <button className="pd-btn ghost" onClick={() => void act(selected.id, 'reload')} disabled={!!busy[selected.id]}>
                    {busy[selected.id] ? <span className="spin" /> : null}重载
                  </button>
                  <button className="pd-btn ghost" onClick={() => void pluginsApi.open(selected.id)}>打开目录</button>
                  <button className="pd-btn danger" onClick={() => void act(selected.id, (selected.state === 'started' || selected.state === 'loaded') ? 'disable' : 'enable')} disabled={!!busy[selected.id]}>
                    {(selected.state === 'started' || selected.state === 'loaded') ? '停用' : '启用'}
                  </button>
                </div>
              </div>
              <div className="pd-manifest">
                <span className="pm-title">MANIFEST</span>
                <div className="pm-row"><span className="k">id</span><span className="v">{selected.id}</span></div>
                <div className="pm-row"><span className="k">state</span><span className="v">{selected.state === 'started' ? 'started（运行中）' : selected.state === 'stopped' ? 'stopped（已停止）' : selected.state === 'error' ? 'error（出错）' : selected.state === 'loaded' ? 'loaded（已加载）' : selected.state}</span></div>
                <div className="pm-row"><span className="k">caps</span><span className="v">{selected.caps?.join(', ') || '—'}</span></div>
                <div className="pm-row"><span className="k">enabled</span><span className="v ok">{(selected.state === 'started' || selected.state === 'loaded') ? <>true <IconCheck size={10} /></> : 'false'}</span></div>
              </div>
              {/* todo 插件：面板含交互（增删改），DOMPurify 会剥离 panel HTML 的脚本 → 特判渲染 React 原生组件 */}
              {selected.id === 'todo' ? <TodoBoardView /> : <PluginPanel pluginId={selected.id} />}
            </>
          ) : (
            <div className="empty-state">← 选择插件查看详情</div>
          )}
          <div className="pd-manifest">
            <span className="pm-title">现场写插件（保存即生效）</span>
            <pre className="code-body" style={{ background: 'var(--bg-input)', borderRadius: 8, border: '1px solid var(--border)', overflowX: 'auto' }}>{`plugins/clock/plugin.json
{ "id": "clock", "name": "时钟工具",
  "version": "0.1.0", "entry": "index.ts", "enabled": true }

// 保存即生效 → PluginLoader 热重载
export default { id: 'clock', async onLoad(ctx) {
  ctx.register({ kind: 'tool', tool: {
    name: 'get_current_time', ... } }); } };`}</pre>
          </div>
        </div>
      </aside>
    </div>
  );
}
