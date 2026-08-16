// ui/src/components/TodoBoardView.tsx —— 待办看板（todo 插件专用 React 面板）
// 背景：插件贡献的 panel HTML 经 DOMPurify 净化会剥离 <script>/onclick，
// 交互全部失效——因此 todo 插件在 PluginsView 中特判渲染本组件（React 原生交互）。
import { useCallback, useEffect, useState } from 'react';
import type { TodoCard, TodoStatus } from '../types';
import { IconWarn } from './Icon';

const COLS: { key: TodoStatus; label: string; color: string }[] = [
  { key: 'todo', label: '待办', color: '#f0b429' },
  { key: 'doing', label: '进行中', color: '#4aa3ff' },
  { key: 'blocked', label: '受阻', color: '#ff6b6b' },
  { key: 'done', label: '完成', color: '#2ecc8f' },
];

const BOARD_API = '/api/plugins/todo/board/cards';

async function loadCards(): Promise<TodoCard[]> {
  const r = await fetch(BOARD_API);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = (await r.json()) as { cards?: TodoCard[] };
  return d.cards ?? [];
}

export default function TodoBoardView() {
  const [cards, setCards] = useState<TodoCard[]>([]);
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setCards(await loadCards()); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000); // 轮询：模型 to do list 实时同步
    return () => clearInterval(t);
  }, [refresh]);

  const add = async () => {
    const t = title.trim();
    if (!t) return;
    try {
      const r = await fetch(BOARD_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTitle('');
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const setStatus = async (id: string, status: TodoStatus) => {
    try {
      const r = await fetch(`${BOARD_API}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (id: string) => {
    try {
      const r = await fetch(`${BOARD_API}/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const done = cards.filter((c) => c.status === 'done').length;

  return (
    <div className="pd-manifest">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="pm-title">PLUGIN PANEL · 待办看板</span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{done}/{cards.length} 完成</span>
        <span style={{ flex: 1 }} />
        <button className="pd-btn ghost" style={{ fontSize: 12 }} title="在独立窗口打开看板（完整页面）"
          onClick={() => window.open('/api/plugins/todo/board/page', '_blank')}>⛶ 独立窗口</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}><IconWarn size={12} /> {err}</div>}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          className="set-input" style={{ flex: 1, height: 32 }} placeholder="新任务标题…"
          value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
        />
        <button className="pd-btn" style={{ fontSize: 13 }} onClick={() => void add()} disabled={!title.trim()}>添加</button>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minHeight: 200 }}>
        {COLS.map((col) => {
          const list = cards.filter((c) => c.status === col.key);
          return (
            <div key={col.key} style={{ flex: 1, minWidth: 0, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: col.color }}>
                {col.label} <span style={{ color: 'var(--text-3)' }}>({list.length})</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
                {list.map((c) => (
                  <div key={c.id} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      {c.title}
                      <span style={{ fontSize: 10, color: c.source === 'agent' ? 'var(--purple)' : 'var(--text-3)', marginLeft: 4 }}>
                        {c.source === 'agent' ? '🤖 模型' : '👤 人类'}
                      </span>
                    </div>
                    {c.desc && <div style={{ color: 'var(--text-3)', marginBottom: 6, whiteSpace: 'pre-wrap', fontSize: 11 }}>{c.desc}</div>}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {COLS.filter((x) => x.key !== c.status).map((x) => (
                        <button key={x.key} className="pd-btn ghost" style={{ padding: '2px 8px', fontSize: 10 }}
                          onClick={() => void setStatus(c.id, x.key)}>{x.label}</button>
                      ))}
                      <button className="pd-btn danger" style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => void remove(c.id)}>删除</button>
                    </div>
                  </div>
                ))}
                {list.length === 0 && <div style={{ color: 'var(--text-4)', fontSize: 11, textAlign: 'center', padding: '14px 0' }}>空</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
