import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, subscribeEvents } from '../../api';
import { runsApi, runLabels, type RunInfo } from '../../run-api';
import { materialApi, type Material, type MaterialRef } from '../../material-api';
import type { PersonalItem } from '../../../../core/todo/items';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldLabel, FieldDescription, FieldGroup } from '@/components/ui/field';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import MaterialViewer from '../../components/MaterialViewer';
import RunFiles from '../../components/RunFiles';
import { Choice } from '../workbench/shared';

interface Attempt {
  runId: string;
  itemRevision: number;
  run?: RunInfo;
}
interface Row extends PersonalItem {
  attempts: Attempt[];
}
const statuses = { todo: '待办', review: '结果待确认', done: '已完成', archived: '已归档' };
export function openSession(id: string) {
  if (window.parent !== window) window.parent.postMessage({ type: 'maharness:open-session', sessionId: id }, location.origin);
  else location.href = `/?session=${encodeURIComponent(id)}`;
}
export default function PersonalItemsView({ overview = false }: { overview?: boolean }) {
  const [items, setItems] = useState<Row[]>([]),
    [projects, setProjects] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('open'),
    [busy, setBusy] = useState(false),
    [quick, setQuick] = useState('');
  const [editing, setEditing] = useState<Row>(),
    [detail, setDetail] = useState<string | undefined>(() => new URLSearchParams(location.search).get('item') ?? undefined),
    [viewing, setViewing] = useState<Material>();
  const quickOperation = useRef({ title: '', id: '' });
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const refs = editing?.materials ?? items.find((item) => item.id === detail)?.materials ?? [];
    void Promise.all(
      refs.map(async (ref) => {
        try {
          return [ref.id, (await materialApi.get(ref.id)).name] as const;
        } catch {
          return [ref.id, '文件不可用'] as const;
        }
      }),
    ).then((entries) => {
      if (alive) setNames((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      alive = false;
    };
  }, [editing?.materials, detail, items]);
  const [workspacePath, setWorkspacePath] = useState('');
  const [legacy, setLegacy] = useState<{ id: string; title: string; status: string }[]>();
  const load = useCallback(async () => {
    try {
      const value = await api<{ items: Row[]; projects: { id: string; name: string }[] }>('/api/items');
      setItems(value.items);
      setProjects(value.projects);
      setError('');
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const stop = subscribeEvents((event) => {
      if (event.type === 'items.updated') void load();
    });
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      stop();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load]);
  async function mutate(fn: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      toast.error(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const patch = (item: Row, change: Record<string, unknown>) =>
    api(`/api/items/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ revision: item.revision, ...change }) });
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!quick.trim()) return;
    if (quickOperation.current.title !== quick) quickOperation.current = { title: quick, id: crypto.randomUUID() };
    const ok = await mutate(() =>
      api('/api/items', {
        method: 'POST',
        body: JSON.stringify({
          title: quick,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          operationId: quickOperation.current.id,
        }),
      }),
    );
    if (ok) {
      setQuick('');
      quickOperation.current = { title: '', id: '' };
    }
  }
  async function execute(item: Row, newAttempt = false) {
    await mutate(async () => {
      const value = await api<{ sessionId: string }>(`/api/items/${item.id}/execute`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ revision: item.revision, newAttempt }),
      });
      openSession(value.sessionId);
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const ok = await mutate(() =>
      patch(editing, {
        title: editing.title,
        note: editing.note,
        prio: editing.prio,
        due: editing.due,
        dueTime: editing.dueTime ?? '',
        timeZone: editing.timeZone,
        repeat: editing.repeat,
        pid: editing.pid,
        materials: editing.materials,
      }),
    );
    if (ok) setEditing(undefined);
  }
  async function attachFiles(files: FileList | null) {
    if (!editing || !files) return;
    setBusy(true);
    try {
      if (editing.materials.length + files.length > 10) throw new Error('最多关联10个文件');
      const added: MaterialRef[] = [];
      for (const file of Array.from(files)) {
        const value = await materialApi.upload(file);
        added.push({ id: value.id, version: value.version });
      }
      setEditing((current) => (current ? { ...current, materials: [...current.materials, ...added] } : current));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }
  const active = (item: Row) =>
    item.attempts.find((a) => a.run && ['queued', 'running', 'waiting_approval', 'stopping'].includes(a.run.status));
  const selected = items.find((item) => item.id === detail);
  const dateFor = (item: Row) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: item.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const today = (item: Row) => !!item.due && item.due <= dateFor(item) && !['done', 'archived'].includes(item.lifecycle);
  const rows = items.filter((item) =>
    filter === 'open'
      ? !['done', 'archived'].includes(item.lifecycle)
      : filter === 'today'
        ? today(item)
        : filter === 'next'
          ? item.lifecycle === 'todo' && item.due > dateFor(item)
          : filter === 'all'
            ? true
            : item.lifecycle === filter,
  );
  function itemCard(item: Row) {
    const attempt = item.attempts[0];
    return (
      <Card key={item.id} data-testid="personal-item">
        <CardHeader>
          <CardTitle>
            <Button variant="link" className="h-auto whitespace-normal p-0 text-left" onClick={() => setDetail(item.id)}>
              {item.title}
            </Button>
          </CardTitle>
          <CardDescription>
            {item.due || '未排期'}
            {item.dueTime ? ` ${item.dueTime} ${item.timeZone}` : ''}
            {item.pid ? ` · ${projects.find((p) => p.id === item.pid)?.name ?? item.pid}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Badge>{statuses[item.lifecycle]}</Badge>
          <Badge variant="outline">优先级 {item.prio}</Badge>
          {active(item)?.run && <Badge variant="secondary">{runLabels[active(item)!.run!.status]}</Badge>}
          {attempt?.run && !active(item) && (
            <span className="text-sm text-muted-foreground">最近执行：{runLabels[attempt.run.status]}</span>
          )}
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(structuredClone(item))}>
            编辑
          </Button>
          {item.lifecycle === 'todo' && (
            <Button size="sm" disabled={busy} onClick={() => void execute(item)}>
              {active(item) ? '查看执行' : '现在执行'}
            </Button>
          )}
          {item.lifecycle === 'review' && (
            <Button size="sm" disabled={busy} onClick={() => void mutate(() => patch(item, { lifecycle: 'done' }))}>
              确认完成
            </Button>
          )}
          {item.lifecycle === 'todo' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(() => patch(item, { lifecycle: 'done' }))}>
              标记完成
            </Button>
          )}
          {['done', 'archived', 'review'].includes(item.lifecycle) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(() => patch(item, { lifecycle: 'todo' }))}>
              重新打开
            </Button>
          )}
          {item.lifecycle !== 'archived' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(() => patch(item, { lifecycle: 'archived' }))}>
              归档
            </Button>
          )}
        </CardFooter>
      </Card>
    );
  }
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1>{overview ? '工作台' : '待办'}</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void load()}>
            刷新
          </Button>
          {overview ? (
            <Button variant="outline" onClick={() => (location.href = '/workbench.html')}>
              完整工作台
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() =>
                void api<{ cards: NonNullable<typeof legacy> }>('/api/plugins/todo/board/cards')
                  .then((value) => setLegacy(value.cards))
                  .catch((e) => toast.error(String(e)))
              }
            >
              历史清单
            </Button>
          )}
        </div>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>读取失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <form onSubmit={add} className="flex gap-2">
        <Input
          aria-label="新增个人事项"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          placeholder="记录一件事…"
          maxLength={200}
        />
        <Button disabled={busy || !quick.trim() || !loaded} type="submit">
          添加
        </Button>
      </form>
      {overview ? (
        <>
          <section className="flex flex-col gap-3" aria-label="今日事项">
            <h2>今日及逾期事项</h2>
            {items.filter(today).map(itemCard)}
            {!items.some(today) && <p className="text-sm text-muted-foreground">暂无今日事项</p>}
          </section>
          <section className="flex flex-col gap-3" aria-label="正在执行">
            <h2>正在执行</h2>
            {items.filter((item) => active(item)).map(itemCard)}
            {!items.some((item) => active(item)) && <p className="text-sm text-muted-foreground">暂无执行中的事项</p>}
          </section>
          <section className="flex flex-col gap-3" aria-label="最近结果">
            <h2>最近结果与待确认事项</h2>
            {items
              .filter((item) => item.lifecycle === 'review' || item.attempts.some((a) => a.run?.status === 'completed'))
              .sort((a, b) => (b.attempts[0]?.run?.updatedAt ?? b.updatedAt) - (a.attempts[0]?.run?.updatedAt ?? a.updatedAt))
              .slice(0, 8)
              .map((item) => (
                <div key={item.id}>
                  {itemCard(item)}
                  {item.executionSessionId && (
                    <RunFiles sessionId={item.executionSessionId} revision={item.attempts[0]?.run?.updatedAt} onOpen={setViewing} />
                  )}
                </div>
              ))}
          </section>
        </>
      ) : (
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            value={filter}
            onValueChange={(value) => {
              if (value) setFilter(value);
            }}
            className="flex-wrap"
          >
            {[
              ['open', '未完成'],
              ['today', '今日'],
              ['next', '接下来'],
              ['all', '全部'],
              ['done', '已完成'],
              ['archived', '已归档'],
            ].map(([value, label]) => (
              <ToggleGroupItem key={value} value={value}>
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {rows.map(itemCard)}
          {loaded && !rows.length && <p className="text-sm text-muted-foreground">暂无事项</p>}
        </>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(undefined);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>编辑事项</DialogTitle>
          </DialogHeader>
          {editing && (
            <form onSubmit={save} className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="item-title">标题</FieldLabel>
                  <Input
                    id="item-title"
                    value={editing.title}
                    maxLength={200}
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="item-note">说明</FieldLabel>
                  <Textarea
                    id="item-note"
                    value={editing.note}
                    maxLength={2000}
                    onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="item-due">日期</FieldLabel>
                  <Input
                    id="item-due"
                    type="date"
                    value={editing.due}
                    onChange={(e) => setEditing({ ...editing, due: e.target.value, ...(!e.target.value ? { dueTime: '' } : {}) })}
                  />
                  <FieldDescription>仅记录安排；不会提醒或到点自动执行。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="item-time">时间（可选）</FieldLabel>
                  <Input
                    id="item-time"
                    type="time"
                    disabled={!editing.due}
                    value={editing.dueTime ?? ''}
                    onChange={(e) => setEditing({ ...editing, dueTime: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="item-zone">时区</FieldLabel>
                  <Input id="item-zone" value={editing.timeZone} onChange={(e) => setEditing({ ...editing, timeZone: e.target.value })} />
                </Field>
                <Field>
                  <FieldLabel>优先级</FieldLabel>
                  <Choice
                    label="事项优先级"
                    value={String(editing.prio)}
                    onChange={(value) => setEditing({ ...editing, prio: Number(value) })}
                    options={[
                      ['1', '紧急'],
                      ['2', '高'],
                      ['3', '中'],
                      ['4', '低'],
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel>项目</FieldLabel>
                  <Select
                    value={editing.pid || '__none'}
                    onValueChange={(value) => setEditing({ ...editing, pid: value === '__none' ? '' : value })}
                  >
                    <SelectTrigger aria-label="事项项目">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="__none">无项目</SelectItem>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>重复</FieldLabel>
                  <Choice
                    label="事项重复"
                    value={editing.repeat}
                    onChange={(value) => setEditing({ ...editing, repeat: value })}
                    options={[
                      ['', '不重复'],
                      ['daily', '每天'],
                      ['weekdays', '工作日'],
                      ['weekly', '每周'],
                      ['monthly', '每月'],
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="item-files">关联资料（最多10个）</FieldLabel>
                  <Input id="item-files" type="file" multiple disabled={busy} onChange={(e) => void attachFiles(e.target.files)} />
                  {editing.materials.map((ref) => (
                    <div key={ref.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs">{names[ref.id] ?? '读取文件名称…'}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({ ...editing, materials: editing.materials.filter((value) => value.id !== ref.id) })}
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </Field>
                <Field>
                  <FieldLabel htmlFor="workspace-path">工作区文件路径</FieldLabel>
                  <Input id="workspace-path" value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !workspacePath.trim() || editing.materials.length >= 10}
                    onClick={() =>
                      void mutate(async () => {
                        const material = await api<Material>('/api/materials/register', {
                          method: 'POST',
                          body: JSON.stringify({ path: workspacePath }),
                        });
                        setEditing((current) =>
                          current
                            ? { ...current, materials: [...current.materials, { id: material.id, version: material.version }] }
                            : current,
                        );
                        setWorkspacePath('');
                      })
                    }
                  >
                    关联工作区文件
                  </Button>
                </Field>
              </FieldGroup>
              <Button disabled={busy || !editing.title.trim()} type="submit">
                保存
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{selected?.title ?? '事项详情'}</DialogTitle>
          </DialogHeader>
          {selected && (
            <>
              <p className="whitespace-pre-wrap">{selected.note}</p>
              <div className="flex flex-wrap gap-2">
                {selected.sourceSessionId && (
                  <Button variant="outline" onClick={() => openSession(selected.sourceSessionId!)}>
                    来源会话
                  </Button>
                )}
                {selected.executionSessionId && (
                  <Button variant="outline" onClick={() => openSession(selected.executionSessionId!)}>
                    执行会话
                  </Button>
                )}
              </div>
              {selected.materials.map((ref) => (
                <Button
                  key={ref.id}
                  variant="ghost"
                  onClick={() =>
                    void materialApi
                      .get(ref.id)
                      .then((material) => {
                        if (material.version !== ref.version) throw new Error('来源版本已变化，请重新关联');
                        setViewing(material);
                      })
                      .catch((e) => toast.error(String(e)))
                  }
                >
                  {names[ref.id] ?? '查看资料'}
                </Button>
              ))}
              {selected.attempts.map((attempt) => (
                <Card key={attempt.runId}>
                  <CardHeader>
                    <CardTitle>执行版本 {attempt.itemRevision}</CardTitle>
                    <CardDescription>
                      {attempt.run ? runLabels[attempt.run.status] : '运行记录不可用'}
                      {attempt.itemRevision !== selected.revision ? ' · 事项已更新' : ''}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="whitespace-pre-wrap text-sm">{attempt.run?.error ?? attempt.run?.answer}</p>
                  </CardContent>
                  <CardFooter className="flex-wrap gap-2">
                    {attempt.run?.status === 'interrupted' && (
                      <>
                        <Button disabled={busy} onClick={() => void mutate(() => runsApi.resume(attempt.runId))}>
                          继续任务
                        </Button>
                        <Button variant="outline" disabled={busy} onClick={() => void execute(selected, true)}>
                          另起执行
                        </Button>
                      </>
                    )}
                    {attempt.run && ['queued', 'running', 'waiting_approval'].includes(attempt.run.status) && (
                      <Button variant="outline" disabled={busy} onClick={() => void mutate(() => runsApi.cancel(attempt.runId))}>
                        停止
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              ))}
              {selected.executionSessionId && (
                <RunFiles sessionId={selected.executionSessionId} revision={selected.attempts[0]?.run?.updatedAt} onOpen={setViewing} />
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={legacy !== undefined}
        onOpenChange={(open) => {
          if (!open) setLegacy(undefined);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>历史清单</DialogTitle>
          </DialogHeader>
          <Button variant="outline" onClick={() => (location.href = '/todo.html?history=1')}>
            打开历史看板与执行清单
          </Button>
          {legacy?.map((card) => (
            <div key={card.id} className="flex items-center justify-between gap-2">
              <span>
                {card.title} · {card.status}
              </span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void mutate(() => api(`/api/items/import-legacy/${encodeURIComponent(card.id)}`, { method: 'POST' }))}
              >
                转入个人事项
              </Button>
            </div>
          ))}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(undefined);
        }}
      >
        <DialogContent className="flex h-[90dvh] max-w-5xl flex-col sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name ?? '文件预览'}</DialogTitle>
          </DialogHeader>
          {viewing && <MaterialViewer material={viewing} />}
        </DialogContent>
      </Dialog>
    </main>
  );
}
