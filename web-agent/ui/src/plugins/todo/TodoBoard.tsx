import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Bot, GripVertical, Pencil, Plus, Search, Trash2, User } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import type { TodoCard, TodoPriority, TodoStatus } from '@/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const ENDPOINT = '/api/plugins/todo/board/cards';
const COLUMNS: { value: TodoStatus; label: string }[] = [
  { value: 'todo', label: '待办' }, { value: 'doing', label: '进行中' },
  { value: 'blocked', label: '受阻' }, { value: 'done', label: '完成' },
];
const PRIORITIES: { value: TodoPriority; label: string }[] = [
  { value: 'low', label: '低' }, { value: 'medium', label: '中' },
  { value: 'high', label: '高' }, { value: 'urgent', label: '紧急' },
];

function StatusSelect({ value, onChange, label, disabled, all = false }: { value: string; onChange: (value: TodoStatus | 'all') => void; label: string; disabled?: boolean; all?: boolean }) {
  return <Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{all && <SelectItem value="all">全部状态</SelectItem>}{COLUMNS.map((column) => <SelectItem key={column.value} value={column.value}>{column.label}</SelectItem>)}</SelectGroup></SelectContent></Select>;
}

function TaskCard({ card, busy, onEdit, onMove, onDelete }: { card: TodoCard; busy: boolean; onEdit: (card: TodoCard) => void; onMove: (id: string, status: TodoStatus) => void; onDelete: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id, disabled: busy });
  const SourceIcon = card.source === 'agent' ? Bot : User;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform) }} className={cn(isDragging && 'opacity-40')} data-task-id={card.id}>
      <Card size="sm">
        <CardHeader><CardTitle className="min-w-0 break-words"><Button variant="link" className="h-auto max-w-full justify-start whitespace-normal p-0 text-left" onClick={() => onEdit(card)}>{card.title}</Button></CardTitle><CardAction><Button variant="ghost" size="icon-xs" aria-label={`拖动任务 ${card.title}`} className="touch-none" {...attributes} {...listeners}><GripVertical /></Button></CardAction><CardDescription className="flex items-center gap-2"><SourceIcon className="size-3.5" />{card.source === 'agent' ? '模型' : '人类'}<Badge variant={card.priority === 'urgent' ? 'destructive' : 'outline'}>{PRIORITIES.find((priority) => priority.value === card.priority)?.label ?? '中'}</Badge></CardDescription></CardHeader>
        {card.desc && <CardContent><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{card.desc}</p></CardContent>}
        <CardFooter className="gap-2"><div className="min-w-0 flex-1"><StatusSelect value={card.status} label={`${card.title} 状态`} disabled={busy} onChange={(status) => { if (status !== 'all') onMove(card.id, status); }} /></div><Button variant="ghost" size="icon-sm" aria-label={`编辑任务 ${card.title}`} onClick={() => onEdit(card)}><Pencil /></Button><Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`删除任务 ${card.title}`} onClick={() => onDelete(card.id)}><Trash2 /></Button></CardFooter>
      </Card>
    </div>
  );
}

function BoardColumn({ status, label, cards, busy, onEdit, onMove, onDelete }: { status: TodoStatus; label: string; cards: TodoCard[]; busy: boolean; onEdit: (card: TodoCard) => void; onMove: (id: string, status: TodoStatus) => void; onDelete: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: busy });
  return <section ref={setNodeRef} aria-label={`${label}任务`} data-status={status} className={cn('flex min-h-40 min-w-0 flex-col gap-3 rounded-xl bg-muted/40 p-3', isOver && 'ring-2 ring-ring')}><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium">{label}</h2><Badge variant="secondary">{cards.length}</Badge></div>{cards.map((card) => <TaskCard key={card.id} card={card} busy={busy} onEdit={onEdit} onMove={onMove} onDelete={onDelete} />)}{!cards.length && <Empty className="border border-dashed py-8"><EmptyHeader><EmptyTitle>暂无任务</EmptyTitle><EmptyDescription>可将卡片拖到此列。</EmptyDescription></EmptyHeader></Empty>}</section>;
}

export default function TodoBoard() {
  const [cards, setCards] = useState<TodoCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestId = useRef(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TodoStatus | 'all'>('all');
  const [source, setSource] = useState('all');
  const [newTitle, setNewTitle] = useState('');
  const [editing, setEditing] = useState<TodoCard | null>(null);
  const [draft, setDraft] = useState({ title: '', desc: '', status: 'todo' as TodoStatus, priority: 'medium' as TodoPriority });
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor));

  const load = useCallback(async () => {
    const current = ++requestId.current;
    try {
      const result = await api<{ cards: TodoCard[] }>(ENDPOINT);
      if (current === requestId.current) { setCards(result.cards); setLoaded(true); setError(null); }
    } catch (err) { if (current === requestId.current) { setError(err instanceof Error ? err.message : String(err)); setLoaded(true); } }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!busyRef.current) void load(); }, 5000);
    return () => { clearInterval(timer); requestId.current++; };
  }, [load]);

  const mutate = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); requestId.current++;
    try { await action(); await load(); return true; }
    catch (err) { toast.error(err instanceof Error ? err.message : String(err)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const move = (id: string, nextStatus: TodoStatus) => { void mutate(() => api(`${ENDPOINT}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) })); };
  const remove = (id: string) => { void mutate(async () => { await api(`${ENDPOINT}/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (editing?.id === id) setEditing(null); }); };
  const openEdit = (card: TodoCard) => { setEditing(card); setDraft({ title: card.title, desc: card.desc ?? '', status: card.status, priority: card.priority }); };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (title && await mutate(() => api(ENDPOINT, { method: 'POST', body: JSON.stringify({ title }) }))) setNewTitle('');
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !draft.title.trim()) return;
    const saved = await mutate(() => api(`${ENDPOINT}/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify({ ...draft, title: draft.title.trim(), desc: draft.desc.trim() }) }));
    if (saved) setEditing(null);
  };
  const drop = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (over && COLUMNS.some((column) => column.value === over.id)) move(String(active.id), over.id as TodoStatus);
  };
  const keyword = query.trim().toLowerCase();
  const filtered = cards.filter((card) => (status === 'all' || card.status === status) && (source === 'all' || card.source === source) && (!keyword || `${card.title} ${card.desc ?? ''}`.toLowerCase().includes(keyword)));
  const activeCard = cards.find((card) => card.id === dragging);

  return (
    <main className="flex h-dvh min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1"><div className="mx-auto flex w-full max-w-none flex-col gap-6 p-4 md:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3"><div><h1>待办看板</h1><p>任务进度与 Agent 执行同步。</p></div><Badge variant="outline">{cards.filter((card) => card.status === 'done').length}/{cards.length} 完成</Badge></header>
        {error && <Alert variant="destructive"><AlertTitle>看板加载失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-col gap-3 lg:flex-row"><InputGroup className="min-w-0 flex-1"><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput aria-label="搜索任务" placeholder="搜索任务…" value={query} onChange={(event) => setQuery(event.target.value)} /></InputGroup><div className="grid grid-cols-2 gap-3 lg:w-80"><StatusSelect all value={status} label="筛选任务状态" onChange={setStatus} /><Select value={source} onValueChange={setSource}><SelectTrigger aria-label="筛选任务来源" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部来源</SelectItem><SelectItem value="human">人类</SelectItem><SelectItem value="agent">模型</SelectItem></SelectGroup></SelectContent></Select></div></div>
        <form onSubmit={(event) => void create(event)}><FieldGroup className="flex-row items-end gap-2"><Field><FieldLabel htmlFor="todo-new-title" className="sr-only">新任务标题</FieldLabel><Input id="todo-new-title" placeholder="新任务标题…" maxLength={200} value={newTitle} disabled={busy} onChange={(event) => setNewTitle(event.target.value)} /></Field><Button type="submit" disabled={busy || !newTitle.trim()}>{busy ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}添加</Button></FieldGroup></form>
        {!loaded ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{COLUMNS.map((column) => <Skeleton key={column.value} className="h-64" />)}</div> : <DndContext sensors={sensors} onDragStart={({ active }) => setDragging(String(active.id))} onDragCancel={() => setDragging(null)} onDragEnd={drop} accessibility={{ screenReaderInstructions: { draggable: '按空格拾起任务，使用方向键移动，按空格放下或 Escape 取消。也可使用任务状态选择器移动。' } }}><div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] items-start gap-4">{COLUMNS.filter((column) => status === 'all' || column.value === status).map((column) => <BoardColumn key={column.value} status={column.value} label={column.label} cards={filtered.filter((card) => card.status === column.value)} busy={busy} onEdit={openEdit} onMove={move} onDelete={remove} />)}</div><DragOverlay>{activeCard && <Card size="sm"><CardHeader><CardTitle>{activeCard.title}</CardTitle><CardDescription>{activeCard.desc}</CardDescription></CardHeader></Card>}</DragOverlay></DndContext>}
      </div></ScrollArea>
      <Sheet open={editing !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}><SheetContent className="w-full sm:max-w-md"><SheetHeader><SheetTitle>编辑任务</SheetTitle><SheetDescription>{editing?.source === 'agent' ? '模型创建的任务' : '人类创建的任务'}</SheetDescription></SheetHeader><form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void save(event)}><ScrollArea className="min-h-0 flex-1"><FieldGroup className="p-4"><Field><FieldLabel htmlFor="todo-title">标题</FieldLabel><Input id="todo-title" required maxLength={200} value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field><Field><FieldLabel htmlFor="todo-desc">描述</FieldLabel><Textarea id="todo-desc" rows={5} maxLength={500} value={draft.desc} disabled={busy} onChange={(event) => setDraft({ ...draft, desc: event.target.value })} /></Field><Field><FieldLabel>状态</FieldLabel><StatusSelect value={draft.status} label="编辑任务状态" disabled={busy} onChange={(next) => { if (next !== 'all') setDraft({ ...draft, status: next }); }} /></Field><Field><FieldLabel htmlFor="todo-priority">优先级</FieldLabel><Select value={draft.priority} disabled={busy} onValueChange={(priority) => setDraft({ ...draft, priority: priority as TodoPriority })}><SelectTrigger id="todo-priority" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{PRIORITIES.map((priority) => <SelectItem key={priority.value} value={priority.value}>{priority.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field></FieldGroup></ScrollArea><SheetFooter><Button type="submit" disabled={busy || !draft.title.trim()}>{busy && <Spinner data-icon="inline-start" />}保存</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>取消</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => { if (editing) remove(editing.id); }}><Trash2 data-icon="inline-start" />删除任务</Button></SheetFooter></form></SheetContent></Sheet>
    </main>
  );
}
