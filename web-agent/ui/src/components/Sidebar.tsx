// ui/src/components/Sidebar.tsx —— 左侧边栏（Logo + 4 Tab + 会话列表 + Footer）
import { useState } from 'react';
import type { Session } from '../types';
import { IconArchive, IconFolder, IconPin, IconPlugin, IconSettings, IconStats, IconTrash } from './Icon';

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

export default function Sidebar({ sessions, activeId, activeTab, onTab, onSelect, onCreate, onDelete, onArchive, onPin, onRename, settingsOpen, onToggleSettings, pluginRunning }: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const pinned = sessions.filter((s) => s.pinned && !s.archived);
  const normal = sessions.filter((s) => !s.pinned && !s.archived);
  const archived = sessions.filter((s) => s.archived);

  const commitRename = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  const renderItem = (s: Session) => (
    <div
      key={s.id}
      className={`sb-session-item ${s.id === activeId ? 'active' : ''}`}
      onClick={() => onSelect(s.id)}
      onDoubleClick={() => { setEditingId(s.id); setDraft(s.title || ''); }}
      onMouseEnter={() => setHoverId(s.id)}
      onMouseLeave={() => setHoverId(null)}
      title={s.title || '新会话'}
    >
      {s.id === activeId && <span className="dot" />}
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
      {hoverId === s.id && (
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
          <div className="sb-logo-mark">M</div>
          <div className="sb-logo-title">maharness</div>
        </div>
      </div>

      <div className="sb-tabs">
        <button className={`sb-tab ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => onTab('chat')}>
          <span className="tab-icon">✦</span>会话
        </button>
        <button className={`sb-tab ${activeTab === 'files' ? 'active' : ''}`} onClick={() => onTab('files')}>
          <span className="tab-icon"><IconFolder size={13} /></span>文件
        </button>
        <button className={`sb-tab ${activeTab === 'plugins' ? 'active' : ''}`} onClick={() => onTab('plugins')}>
          <span className="tab-icon"><IconPlugin size={13} /></span>插件
        </button>
        <button className={`sb-tab ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => onTab('stats')}>
          <span className="tab-icon"><IconStats size={13} /></span>统计
        </button>
      </div>

      <div className="sb-divider" />

      <button className="sb-new-chat" onClick={onCreate}><span style={{ fontSize: 16, fontWeight: 400 }}>+</span>新会话</button>

      <div className="sb-session-scroll">
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
    </aside>
  );
}
