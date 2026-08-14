// ui/src/components/SessionList.tsx —— 会话列表
import type { Session } from '../types';

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export default function SessionList({ sessions, activeId, onSelect, onCreate, onDelete }: Props) {
  return (
    <div className="session-list">
      <button className="btn new-session" onClick={() => void onCreate()}>＋ 新会话</button>
      {sessions.map((s) => (
        <div key={s.id} className={`session-item ${s.id === activeId ? 'active' : ''}`} onClick={() => void onSelect(s.id)}>
          <div className="session-title">{s.title}</div>
          <div className="session-time">{new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
          <button className="session-del" title="删除会话" onClick={(e) => { e.stopPropagation(); void onDelete(s.id); }}>✕</button>
        </div>
      ))}
      {sessions.length === 0 && <div className="empty-hint">暂无会话</div>}
    </div>
  );
}
