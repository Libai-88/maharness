// ui/src/components/Sidebar.tsx —— 左侧边栏（羊 Logo + 4 Tab + 会话列表 + 批量管理 + Footer）
import { useState } from 'react';
import type { Session } from '../types';
import { IconArchive, IconChat, IconClose, IconFolder, IconManage, IconPin, IconPlugin, IconPlus, IconSettings, IconSheep, IconStats, IconTrash } from './Icon';

export type MainTab = 'chat' | 'files' | 'plugins' | 'stats';

interface Props {
  sessions: Session[];
  activeId: string | null;
  activeTab: MainTab;
  onTab: (t: MainTab) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => void;
  onBatchDelete: (ids: string[]) => void;
  onBatchArchive: (ids: string[]) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  pluginRunning: number;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function Sidebar({
  sessions, activeId, activeTab, onTab, onSelect, onCreate, onDelete, onArchive, onPin, onRename,
  onBatchDelete, onBatchArchive, settingsOpen, onToggleSettings, pluginRunning,
}: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const pinned = sessions.filter((s) => s.pinned && !s.archived);
  const normal = sessions.filter((s) => !s.pinned && !s.archived);
  const archived = sessions.filter((s) => s.archived);
  const allIds = sessions.map((s) => s.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const commitRename = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allIds));
  };

  const exitManage = () => {
    setManaging(false);
    setSelected(new Set());
  };

  const doBatchDelete = () => {
    if (!selected.size) return;
    if (confirm(`删除选中的 ${selected.size} 个会话？该操作不可恢复。`)) {
      onBatchDelete([...selected]);
      exitManage();
    }
  };

  const doBatchArchive = () => {
    if (!selected.size) return;
    onBatchArchive([...selected]);
    exitManage();
  };

  const renderItem = (s: Session) => (
    <div
      key={s.id}
      className={`sb-session-item ${s.id === activeId ? 'active' : ''} ${managing ? 'managing' : ''}`}
      onClick={() => { if (managing) toggleSelect(s.id); else onSelect(s.id); }}
      onDoubleClick={() => { if (!managing) { setEditingId(s.id); setDraft(s.title || ''); } }}
      onMouseEnter={() => setHoverId(s.id)}
      onMouseLeave={() => setHoverId(null)}
      title={s.title || '新会话'}
      role="button"
      tabIndex={0}
      aria-current={s.id === activeId ? 'true' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (managing) toggleSelect(s.id); else onSelect(s.id); }
        if (e.key === 'F2' && !managing) { setEditingId(s.id); setDraft(s.title || ''); }
      }}
    >
      {managing ? (
        <span className={`sb-check ${selected.has(s.id) ? 'checked' : ''}`} onClick={(e) => { e.stopPropagation(); toggleSelect(s.id); }} role="checkbox" aria-checked={selected.has(s.id)} aria-label={`选择 ${s.title || '新会话'}`} />
      ) : (
        s.id === activeId && <span className="dot" />
      )}
      {editingId === s.id ? (
        <input
          className="sb-rename-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') setEditingId(null);
            e.stopPropagation();
          }}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span className="name">{s.title || '新会话'}</span>
          {s.mode !== 'normal' && <span className="pin">{s.mode === 'plan' ? 'P' : 'G'}</span>}
          <span className="time">{fmtTime(s.updatedAt)}</span>
        </>
      )}
      {!managing && hoverId === s.id && (
        <span className="item-actions" onClick={(e) => e.stopPropagation()}>
          <button title="置顶" aria-label="置顶" onClick={() => onPin(s.id, !s.pinned)}><IconPin size={12} /></button>
          <button title="归档" aria-label="归档" onClick={() => onArchive(s.id, !s.archived)}><IconArchive size={12} /></button>
          <button title="删除" aria-label="删除" onClick={() => { if (confirm('删除该会话？')) onDelete(s.id); }}><IconTrash size={12} /></button>
        </span>
      )}
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="sb-logo">
        <div className="sb-logo-left">
          <div className="sb-logo-mark"><IconSheep size={17} /></div>
          <div className="sb-logo-title">maharness</div>
        </div>
      </div>

      <div className="sb-tabs">
        <button className={`sb-tab ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => onTab('chat')}>
          <IconChat size={14} />会话
        </button>
        <button className={`sb-tab ${activeTab === 'files' ? 'active' : ''}`} onClick={() => onTab('files')}>
          <IconFolder size={14} />文件
        </button>
        <button className={`sb-tab ${activeTab === 'plugins' ? 'active' : ''}`} onClick={() => onTab('plugins')}>
          <IconPlugin size={14} />插件
        </button>
        <button className={`sb-tab ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => onTab('stats')}>
          <IconStats size={14} />统计
        </button>
      </div>

      <div className="sb-divider" />

      <div className="sb-new-row">
        <button className="sb-new-chat" onClick={() => { if (!managing) onCreate(); }}><IconPlus size={15} />新会话</button>
        <button
          className={`sb-manage-btn ${managing ? 'active' : ''}`}
          onClick={() => { if (managing) exitManage(); else setManaging(true); }}
          title={managing ? '退出批量管理' : '批量管理会话'}
          aria-label={managing ? '退出批量管理' : '批量管理会话'}
        >
          {managing ? <IconClose size={15} /> : <IconManage size={15} />}
        </button>
      </div>

      <div className="sb-session-scroll">
        {managing && (
          <div className="sb-manage-bar">
            <button className="sb-mg-link" onClick={toggleAll}>{allSelected ? '取消全选' : '全选'}</button>
            <span className="sb-mg-count">{selected.size} 已选</span>
          </div>
        )}
        {sessions.length === 0 && <div className="empty-state" style={{ padding: '24px 12px' }}>暂无会话</div>}
        {pinned.length > 0 && <div className="sb-group-label">已置顶</div>}
        {pinned.map(renderItem)}
        {normal.length > 0 && <div className="sb-group-label">会话</div>}
        {normal.map(renderItem)}
        {archived.length > 0 && (
          <>
            <div className="sb-group-label">归档</div>
            {archived.map(renderItem)}
          </>
        )}
      </div>

      {managing ? (
        <div className="sb-manage-actions">
          <button className="sb-ma-btn" onClick={doBatchArchive} disabled={!selected.size} title="归档选中会话">
            <IconArchive size={13} />归档
          </button>
          <button className="sb-ma-btn danger" onClick={doBatchDelete} disabled={!selected.size} title="删除选中会话">
            <IconTrash size={13} />删除
          </button>
          <button className="sb-ma-btn primary" onClick={exitManage}>完成</button>
        </div>
      ) : (
        <div className="sb-footer">
          <div className="sb-foot-row">
            <div className="sb-foot-left">
              <span className="sb-foot-chip">{pluginRunning} running</span>
            </div>
            <span className="sb-foot-chip" style={{ color: 'var(--text-3)' }}>v0.1.2</span>
          </div>
          <button className={`sb-settings-btn ${settingsOpen ? 'active' : ''}`} onClick={onToggleSettings}>
            <IconSettings size={14} />
            <span>设置</span>
          </button>
        </div>
      )}
    </aside>
  );
}
