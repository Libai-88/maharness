// ui/src/components/SessionList.tsx —— 会话列表（置顶 / 普通 / 归档分组 + hover 操作条）
import { useState } from 'react';
import type { Session } from '../types';

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onPin: (id: string, pinned: boolean) => void;
}

function SessionItem({ s, active, onSelect, onDelete, onArchive, onPin }: {
  s: Session; active: boolean;
  onSelect: () => void; onDelete: () => void; onArchive: () => void; onPin: () => void;
}) {
  return (
    <div className={`session-item ${active ? 'active' : ''} ${s.pinned ? 'pinned' : ''}`} onClick={onSelect}>
      <div className="session-title">{s.title}</div>
      <div className="session-time">{new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
      <div className="session-actions" onClick={(e) => e.stopPropagation()}>
        <button title={s.pinned ? '取消置顶' : '置顶'} onClick={onPin}>{s.pinned ? '📌' : '📍'}</button>
        <button title={s.archived ? '恢复' : '归档'} onClick={onArchive}>🗄</button>
        <button className="danger" title="删除" onClick={onDelete}>✕</button>
      </div>
    </div>
  );
}

export default function SessionList({ sessions, activeId, onSelect, onCreate, onDelete, onArchive, onPin }: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false);

  const active = sessions.filter((s) => !s.archived);
  const pinned = active.filter((s) => s.pinned);
  const normal = active.filter((s) => !s.pinned);
  const archived = sessions.filter((s) => s.archived);

  const item = (s: Session) => (
    <SessionItem
      key={s.id}
      s={s}
      active={s.id === activeId}
      onSelect={() => onSelect(s.id)}
      onDelete={() => { if (confirm(`删除会话「${s.title}」？此操作不可恢复。`)) onDelete(s.id); }}
      onArchive={() => onArchive(s.id, !s.archived)}
      onPin={() => onPin(s.id, !s.pinned)}
    />
  );

  return (
    <div className="session-list">
      <button className="btn new-session" onClick={() => void onCreate()}>＋ 新会话</button>
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
