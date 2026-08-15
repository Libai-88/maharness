// ui/src/components/SessionList.tsx —— 会话列表（置顶/普通/归档分组 + hover 操作条 + 批量管理模式）
import { useState } from 'react';
import type { Session } from '../types';

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onBatchDelete: (ids: string[]) => void;
  onArchive: (id: string, archived: boolean) => void;
  onPin: (id: string, pinned: boolean) => void;
}

function SessionItem({ s, active, selectable, checked, onSelect, onToggle, onDelete, onArchive, onPin }: {
  s: Session; active: boolean;
  selectable: boolean; checked: boolean;
  onSelect: () => void; onToggle: () => void;
  onDelete: () => void; onArchive: () => void; onPin: () => void;
}) {
  return (
    <div
      className={`session-item ${active ? 'active' : ''} ${s.pinned ? 'pinned' : ''} ${checked ? 'checked' : ''}`}
      onClick={selectable ? onToggle : onSelect}
    >
      {selectable && (
        <span className={`session-check ${checked ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          {checked ? '☑' : '☐'}
        </span>
      )}
      <div className="session-body">
        <div className="session-title">{s.title}</div>
        <div className="session-time">{new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      {!selectable && (
        <div className="session-actions" onClick={(e) => e.stopPropagation()}>
          <button title={s.pinned ? '取消置顶' : '置顶'} onClick={onPin}>{s.pinned ? '📌' : '📍'}</button>
          <button title={s.archived ? '恢复' : '归档'} onClick={onArchive}>🗄</button>
          <button className="danger" title="删除" onClick={onDelete}>✕</button>
        </div>
      )}
    </div>
  );
}

export default function SessionList({ sessions, activeId, onSelect, onCreate, onDelete, onBatchDelete, onArchive, onPin }: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [manageMode, setManageMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const active = sessions.filter((s) => !s.archived);
  const pinned = active.filter((s) => s.pinned);
  const normal = active.filter((s) => !s.pinned);
  const archived = sessions.filter((s) => s.archived);

  const toggle = (id: string) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAll = () => {
    const all = sessions.map((s) => s.id);
    const allChecked = all.every((id) => checked.has(id));
    setChecked(allChecked ? new Set() : new Set(all));
  };

  const batchDelete = () => {
    if (checked.size === 0) return;
    if (!confirm(`删除选中的 ${checked.size} 个会话？此操作不可恢复。`)) return;
    onBatchDelete([...checked]);
    setChecked(new Set());
    setManageMode(false);
  };

  const exitManage = () => { setManageMode(false); setChecked(new Set()); };

  const item = (s: Session) => (
    <SessionItem
      key={s.id}
      s={s}
      active={s.id === activeId}
      selectable={manageMode}
      checked={checked.has(s.id)}
      onSelect={() => onSelect(s.id)}
      onToggle={() => toggle(s.id)}
      onDelete={() => { if (confirm(`删除会话「${s.title}」？此操作不可恢复。`)) onDelete(s.id); }}
      onArchive={() => onArchive(s.id, !s.archived)}
      onPin={() => onPin(s.id, !s.pinned)}
    />
  );

  return (
    <div className="session-list">
      <div className="session-toolbar">
        {!manageMode ? (
          <>
            <button className="btn new-session" onClick={() => void onCreate()}>＋ 新会话</button>
            <button className="manage-btn" title="批量管理（多选删除）" onClick={() => setManageMode(true)}>🛠</button>
          </>
        ) : (
          <>
            <button className="manage-btn" onClick={toggleAll} title="全选/取消全选">全选</button>
            <span className="manage-count">{checked.size} 个已选</span>
            <button className="manage-btn danger" onClick={batchDelete} disabled={checked.size === 0} title="批量删除">🗑 删除</button>
            <button className="manage-btn" onClick={exitManage} title="退出批量管理">完成</button>
          </>
        )}
      </div>
      {pinned.length > 0 && <div className="session-group-title">📌 置顶</div>}
      {pinned.map(item)}
      {normal.map(item)}
      {sessions.length === 0 && <div className="empty-hint">暂无会话</div>}
      {archived.length > 0 && (
        <>
          <button className="archive-toggle" onClick={() => setArchivedOpen((v) => !v)}>
            🗄 已归档（{archived.length}）{archivedOpen ? '▾' : '▸'}
          </button>
          {archivedOpen && archived.map(item)}
        </>
      )}
    </div>
  );
}
