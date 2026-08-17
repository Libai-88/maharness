// ui/src/components/TodoBoardView.tsx —— 产品级待办看板（拖拽排序 + 详情编辑 + 搜索筛选 + SSE 实时）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragStartEvent, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { subscribeEvents } from '../api';
import type { BusEvent, TodoCard, TodoPriority, TodoStatus } from '../types';

// ─── 常量 ───────────────────────────────────────────────────
const API = '/api/plugins/todo/board';
const COLS: { key: TodoStatus; label: string; color: string }[] = [
  { key: 'todo', label: '待办', color: '#d9a441' },
  { key: 'doing', label: '进行中', color: '#d0856b' },
  { key: 'blocked', label: '受阻', color: '#d96856' },
  { key: 'done', label: '完成', color: '#82a873' },
];
const PRIORITIES: { key: TodoPriority; label: string; color: string }[] = [
  { key: 'low', label: '低', color: '#7d7162' },
  { key: 'medium', label: '中', color: '#d9a441' },
  { key: 'high', label: '高', color: '#d0856b' },
  { key: 'urgent', label: '紧急', color: '#d96856' },
];
const PRIORITY_MAP = Object.fromEntries(PRIORITIES.map((p) => [p.key, p])) as Record<TodoPriority, typeof PRIORITIES[0]>;

// ─── 可排序卡片 ─────────────────────────────────────────────
function SortableCard({ card, onOpen }: { card: TodoCard; onOpen: (c: TodoCard) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, data: { card } });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const pri = PRIORITY_MAP[card.priority] ?? PRIORITY_MAP.medium;
  return (
    <div ref={setNodeRef} style={style} className={`tb-card ${isDragging ? 'dragging' : ''}`} {...attributes} {...listeners} onClick={() => onOpen(card)}>
      <div className="tb-card-head">
        <span className="tb-pri-dot" style={{ background: pri.color }} title={pri.label} />
        <span className="tb-card-title">{card.title}</span>
        {card.source === 'agent' && <span className="tb-card-src">🤖</span>}
      </div>
      {card.desc && <div className="tb-card-desc">{card.desc}</div>}
    </div>
  );
}

// ─── 拖拽预览卡片 ───────────────────────────────────────────
function DragPreview({ card }: { card: TodoCard }) {
  const pri = PRIORITY_MAP[card.priority] ?? PRIORITY_MAP.medium;
  return (
    <div className="tb-card tb-card-preview">
      <div className="tb-card-head">
        <span className="tb-pri-dot" style={{ background: pri.color }} />
        <span className="tb-card-title">{card.title}</span>
      </div>
    </div>
  );
}

// ─── 详情编辑面板 ───────────────────────────────────────────
function DetailPanel({ card, onClose, onSave, onDelete }: {
  card: TodoCard;
  onClose: () => void;
  onSave: (id: string, patch: Partial<TodoCard>) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [desc, setDesc] = useState(card.desc ?? '');
  const [priority, setPriority] = useState<TodoPriority>(card.priority);
  const [status, setStatus] = useState<TodoStatus>(card.status);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = () => {
    onSave(card.id, { title: title.trim() || card.title, desc: desc.trim() || undefined, priority, status });
    onClose();
  };

  return (
    <div className="tb-detail-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tb-detail">
        <div className="tb-detail-head">
          <span className="tb-detail-title">编辑卡片</span>
          <button className="tb-detail-close" onClick={onClose}>✕</button>
        </div>
        <div className="tb-detail-body">
          <label className="tb-label">标题</label>
          <input className="tb-input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />

          <label className="tb-label">描述</label>
          <textarea className="tb-textarea" value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} placeholder="补充说明（可选）" />

          <label className="tb-label">优先级</label>
          <div className="tb-pri-row">
            {PRIORITIES.map((p) => (
              <button key={p.key} className={`tb-pri-btn ${priority === p.key ? 'active' : ''}`} style={{ '--pri-color': p.color } as React.CSSProperties} onClick={() => setPriority(p.key)}>
                <span className="tb-pri-dot" style={{ background: p.color }} />{p.label}
              </button>
            ))}
          </div>

          <label className="tb-label">状态</label>
          <div className="tb-status-row">
            {COLS.map((c) => (
              <button key={c.key} className={`tb-status-btn ${status === c.key ? 'active' : ''}`} style={{ '--col-color': c.color } as React.CSSProperties} onClick={() => setStatus(c.key)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="tb-detail-foot">
          <button className="tb-btn-danger" onClick={() => { onDelete(card.id); onClose(); }}>删除</button>
          <div style={{ flex: 1 }} />
          <button className="tb-btn-ghost" onClick={onClose}>取消</button>
          <button className="tb-btn-primary" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  );
}

// ─── 主组件 ─────────────────────────────────────────────────
export default function TodoBoardView() {
  const [cards, setCards] = useState<TodoCard[]>([]);
  const [title, setTitle] = useState('');
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<TodoStatus | 'all'>('all');
  const [filterSource, setFilterSource] = useState<'all' | 'agent' | 'human'>('all');
  const [editing, setEditing] = useState<TodoCard | null>(null);
  const [activeCard, setActiveCard] = useState<TodoCard | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── 数据加载 ──
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/cards`);
      const d = await r.json();
      setCards(d.cards ?? []);
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // ── SSE 实时更新（替换 5 秒轮询） ──
  useEffect(() => {
    const off = subscribeEvents((e: BusEvent) => {
      if (e.type === 'todo.updated') {
        const data = e.data as { cards?: TodoCard[] } | undefined;
        if (data?.cards) setCards(data.cards);
      }
    });
    return off;
  }, []);

  // ── 搜索与筛选 ──
  const filtered = useMemo(() => {
    let list = cards;
    if (filterStatus !== 'all') list = list.filter((c) => c.status === filterStatus);
    if (filterSource !== 'all') list = list.filter((c) => c.source === filterSource);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.title.toLowerCase().includes(q) || (c.desc ?? '').toLowerCase().includes(q));
    }
    return list;
  }, [cards, filterStatus, filterSource, search]);

  const colCards = useMemo(() => {
    const map: Record<TodoStatus, TodoCard[]> = { todo: [], doing: [], done: [], blocked: [] };
    for (const c of filtered) map[c.status].push(c);
    return map;
  }, [filtered]);

  const doneCount = cards.filter((c) => c.status === 'done').length;

  // ── CRUD ──
  const addCard = useCallback(async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await fetch(`${API}/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t }) });
      setTitle('');
      await refresh();
    } finally { setBusy(false); }
  }, [title, busy, refresh]);

  const saveCard = useCallback(async (id: string, patch: Partial<TodoCard>) => {
    await fetch(`${API}/cards/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    await refresh();
  }, [refresh]);

  const deleteCard = useCallback(async (id: string) => {
    await fetch(`${API}/cards/${id}`, { method: 'DELETE' });
    await refresh();
  }, [refresh]);

  // ── 拖拽 ──
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const card = e.active.data.current?.card as TodoCard | undefined;
    if (card) setActiveCard(card);
  }, []);

  const handleDragEnd = useCallback(async (e: DragEndEvent) => {
    setActiveCard(null);
    const { active, over } = e;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    if (activeId === overId) return;

    // 确定目标列
    let targetStatus: TodoStatus | null = null;
    const overCard = cards.find((c) => c.id === overId);
    if (overCard) {
      targetStatus = overCard.status;
    } else {
      // over 可能是列占位 id（格式: "col-todo"）
      const colKey = overId.replace('col-', '') as TodoStatus;
      if (COLS.some((c) => c.key === colKey)) targetStatus = colKey;
    }
    if (!targetStatus) return;

    // 乐观更新
    setCards((prev) => {
      const next = [...prev];
      const aIdx = next.findIndex((c) => c.id === activeId);
      if (aIdx === -1) return prev;
      const card = { ...next[aIdx], status: targetStatus! };
      next.splice(aIdx, 1);
      const oIdx = next.findIndex((c) => c.id === overId);
      if (oIdx >= 0) next.splice(oIdx, 0, card);
      else {
        const last = next.reduce((m, c, i) => c.status === targetStatus! ? i : m, -1);
        next.splice(last + 1, 0, card);
      }
      // 重算 order
      const orderMap: Record<TodoStatus, number> = { todo: 0, doing: 0, done: 0, blocked: 0 };
      for (const c of next) c.order = orderMap[c.status]++;
      return next;
    });

    // 同步后端
    try {
      const payload = cards.map((c) => {
        if (c.id === activeId) return { id: c.id, status: targetStatus!, order: c.order };
        return { id: c.id, status: c.status, order: c.order };
      });
      // 重排
      const aIdx = payload.findIndex((c) => c.id === activeId);
      if (aIdx >= 0) {
        const item = payload.splice(aIdx, 1)[0];
        const oIdx = payload.findIndex((c) => c.id === overId);
        if (oIdx >= 0) payload.splice(oIdx, 0, item);
        else {
          const last = payload.reduce((m, c, i) => c.status === targetStatus! ? i : m, -1);
          payload.splice(last + 1, 0, item);
        }
        const orderMap: Record<TodoStatus, number> = { todo: 0, doing: 0, done: 0, blocked: 0 };
        for (const c of payload) c.order = orderMap[c.status as TodoStatus]++;
      }
      await fetch(`${API}/cards/reorder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards: payload }),
      });
    } catch { /* SSE 会推送正确状态 */ }
  }, [cards]);

  return (
    <div className="tb-root">
      {/* ── 工具栏 ── */}
      <div className="tb-toolbar">
        <span className="tb-summary">{doneCount}/{cards.length} 完成</span>
        <div className="tb-spacer" />
        <input className="tb-search" placeholder="搜索…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="tb-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as TodoStatus | 'all')}>
          <option value="all">全部状态</option>
          {COLS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select className="tb-select" value={filterSource} onChange={(e) => setFilterSource(e.target.value as 'all' | 'agent' | 'human')}>
          <option value="all">全部来源</option>
          <option value="human">👤 人类</option>
          <option value="agent">🤖 模型</option>
        </select>
        <div className="tb-spacer" />
        <input ref={inputRef} className="tb-add-input" placeholder="新任务…" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addCard(); }} />
        <button className="tb-btn-add" onClick={() => void addCard()} disabled={busy || !title.trim()}>{busy ? '…' : '＋ 添加'}</button>
        <button className="tb-btn-ghost" onClick={() => window.open(`${API}/page`, '_blank')} title="独立窗口">⛶</button>
      </div>

      {/* ── 看板 ── */}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="tb-board">
          {COLS.map((col) => (
            <div key={col.key} className="tb-col">
              <div className="tb-col-head" style={{ color: col.color }}>
                <span className="tb-col-dot" style={{ background: col.color }} />
                {col.label}
                <span className="tb-col-count">{colCards[col.key].length}</span>
              </div>
              <SortableContext items={colCards[col.key].map((c) => c.id)} strategy={verticalListSortingStrategy}>
                <div className="tb-col-body" data-col-id={`col-${col.key}`}>
                  {colCards[col.key].map((card) => (
                    <SortableCard key={card.id} card={card} onOpen={setEditing} />
                  ))}
                  {colCards[col.key].length === 0 && <div className="tb-col-empty">拖拽卡片到这里</div>}
                </div>
              </SortableContext>
            </div>
          ))}
        </div>
        <DragOverlay>{activeCard ? <DragPreview card={activeCard} /> : null}</DragOverlay>
      </DndContext>

      {/* ── 详情面板 ── */}
      {editing && <DetailPanel card={editing} onClose={() => setEditing(null)} onSave={saveCard} onDelete={deleteCard} />}
    </div>
  );
}
