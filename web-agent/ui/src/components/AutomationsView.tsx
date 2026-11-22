import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  Check,
  Clock3,
  FileClock,
  Link2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  TimerReset,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  automationApi,
  type Automation,
  type AutomationCreateInput,
  type AutomationOccurrence,
  type AutomationTrigger,
} from '../automation-api';
import { runLabels, type RunStatus } from '../run-api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Skeleton } from './ui/skeleton';
import { Textarea } from './ui/textarea';

type TriggerKind = 'manual' | 'once' | 'schedule' | 'file' | 'url';

interface FormState {
  name: string;
  prompt: string;
  kind: TriggerKind;
  at: string;
  recurrence: 'daily' | 'weekdays' | 'weekly' | 'monthly';
  time: string;
  timeZone: string;
  dayOfWeek: string;
  dayOfMonth: string;
  path: string;
  url: string;
}

const emptyForm = (): FormState => ({
  name: '',
  prompt: '',
  kind: 'once',
  at: '',
  recurrence: 'daily',
  time: '09:00',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dayOfWeek: '1',
  dayOfMonth: '1',
  path: '',
  url: '',
});

const dateTime = (timestamp?: number) =>
  timestamp ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp) : '未安排';

const stateLabel: Record<string, string> = {
  draft: '待确认',
  active: '已启用',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
  running: '运行中',
  skipped: '已跳过',
};

function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.type === 'manual') return '手动运行';
  if (trigger.type === 'once') return `单次 · ${dateTime(trigger.at)}`;
  if (trigger.type === 'schedule') {
    const recurrence = { daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月' }[trigger.recurrence];
    return `${recurrence} ${trigger.time} · ${trigger.timeZone}`;
  }
  if (trigger.type === 'file') return `文件变化 · ${trigger.path}`;
  return `网址变化 · ${trigger.url}`;
}

function buildTrigger(form: FormState): AutomationTrigger {
  if (form.kind === 'manual') return { type: 'manual' };
  if (form.kind === 'once') {
    const at = new Date(form.at).getTime();
    if (!Number.isFinite(at)) throw new Error('请选择运行时间');
    return { type: 'once', at };
  }
  if (form.kind === 'schedule')
    return {
      type: 'schedule',
      recurrence: form.recurrence,
      time: form.time,
      timeZone: form.timeZone,
      ...(form.recurrence === 'weekly' ? { dayOfWeek: Number(form.dayOfWeek) } : {}),
      ...(form.recurrence === 'monthly' ? { dayOfMonth: Number(form.dayOfMonth) } : {}),
    };
  if (form.kind === 'file') {
    if (!form.path.trim()) throw new Error('请填写工作区内的相对文件路径');
    return { type: 'file', path: form.path.trim() };
  }
  if (!form.url.trim()) throw new Error('请填写要监控的公开网址');
  return { type: 'url', url: form.url.trim() };
}

function toForm(item: Automation): FormState {
  const form = emptyForm();
  form.name = item.name;
  form.prompt = item.prompt;
  form.kind = item.trigger.type;
  if (item.trigger.type === 'once') {
    const value = new Date(item.trigger.at);
    form.at = new Date(item.trigger.at - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  } else if (item.trigger.type === 'schedule') {
    form.recurrence = item.trigger.recurrence;
    form.time = item.trigger.time;
    form.timeZone = item.trigger.timeZone;
    form.dayOfWeek = String(item.trigger.dayOfWeek ?? 1);
    form.dayOfMonth = String(item.trigger.dayOfMonth ?? 1);
  } else if (item.trigger.type === 'file') form.path = item.trigger.path;
  else if (item.trigger.type === 'url') form.url = item.trigger.url;
  return form;
}

function TriggerFields({ form, setForm }: { form: FormState; setForm: (next: FormState) => void }) {
  if (form.kind === 'manual') return <p className="text-sm text-muted-foreground">保存后在自动化页面点击“立即运行”。</p>;
  if (form.kind === 'once')
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="automation-at">运行时间</Label>
        <Input
          id="automation-at"
          type="datetime-local"
          value={form.at}
          onChange={(event) => setForm({ ...form, at: event.target.value })}
        />
      </div>
    );
  if (form.kind === 'schedule')
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>周期</Label>
          <Select value={form.recurrence} onValueChange={(value) => setForm({ ...form, recurrence: value as FormState['recurrence'] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">每天</SelectItem>
              <SelectItem value="weekdays">工作日</SelectItem>
              <SelectItem value="weekly">每周</SelectItem>
              <SelectItem value="monthly">每月</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="automation-time">运行时间</Label>
          <Input id="automation-time" type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />
        </div>
        {form.recurrence === 'weekly' && (
          <div className="flex flex-col gap-1.5">
            <Label>星期</Label>
            <Select value={form.dayOfWeek} onValueChange={(dayOfWeek) => setForm({ ...form, dayOfWeek })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, index) => (
                  <SelectItem key={label} value={String(index)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {form.recurrence === 'monthly' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-day">每月日期</Label>
            <Input
              id="automation-day"
              type="number"
              min={1}
              max={31}
              value={form.dayOfMonth}
              onChange={(event) => setForm({ ...form, dayOfMonth: event.target.value })}
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="automation-zone">时区</Label>
          <Input
            id="automation-zone"
            value={form.timeZone}
            onChange={(event) => setForm({ ...form, timeZone: event.target.value })}
            placeholder="Asia/Shanghai"
          />
        </div>
      </div>
    );
  if (form.kind === 'file')
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="automation-file">工作区相对路径</Label>
        <Input
          id="automation-file"
          value={form.path}
          onChange={(event) => setForm({ ...form, path: event.target.value })}
          placeholder="资料/报告.csv"
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="automation-url">公开网址</Label>
      <Input
        id="automation-url"
        type="url"
        value={form.url}
        onChange={(event) => setForm({ ...form, url: event.target.value })}
        placeholder="https://example.com/feed"
      />
    </div>
  );
}

export default function AutomationsView({ onSession }: { onSession: (id: string) => void }) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [occurrences, setOccurrences] = useState<AutomationOccurrence[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const value = await automationApi.list();
      setAutomations(value.automations);
      setOccurrences(value.occurrences);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const recent = useMemo(() => {
    const grouped = new Map<string, AutomationOccurrence[]>();
    for (const occurrence of occurrences) {
      const list = grouped.get(occurrence.automationId) ?? [];
      list.push(occurrence);
      grouped.set(occurrence.automationId, list);
    }
    return grouped;
  }, [occurrences]);

  const save = async () => {
    setBusy('save');
    try {
      const input: AutomationCreateInput = { name: form.name.trim(), prompt: form.prompt.trim(), trigger: buildTrigger(form) };
      if (!input.name || !input.prompt) throw new Error('请填写名称和要执行的任务');
      if (editing) await automationApi.update(editing.id, editing.revision, input);
      else await automationApi.create(input);
      setForm(emptyForm());
      setEditing(null);
      await load();
      toast.success(editing ? '自动化已更新，请检查确认状态' : '自动化已保存');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const action = async (id: string, run: () => Promise<unknown>, message: string) => {
    setBusy(id);
    try {
      await run();
      await load();
      toast.success(message);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  if (!loaded)
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-20" />
        <Skeleton className="h-64" />
      </div>
    );
  if (error)
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <AlertCircle />
          <EmptyTitle>自动化暂时不可用</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw data-icon="inline-start" />
          重试
        </Button>
      </Empty>
    );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto grid w-full max-w-6xl gap-5 p-4 md:p-6 lg:grid-cols-[.9fr_1.1fr]" data-testid="automations-view">
        <Card className="self-start">
          <CardHeader>
            <CardTitle>{editing ? '修改自动化' : '新建自动化'}</CardTitle>
            <CardDescription>用自然语言说明任务，再选一个简单触发方式。无需编写 cron 或脚本。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="automation-name">名称</Label>
              <Input
                id="automation-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="每周整理项目进展"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="automation-prompt">要执行的任务</Label>
              <Textarea
                id="automation-prompt"
                rows={5}
                value={form.prompt}
                onChange={(event) => setForm({ ...form, prompt: event.target.value })}
                placeholder="阅读本周新增文件，整理进展、风险和下周计划，并生成一份 DOCX。"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>触发方式</Label>
              <Select value={form.kind} onValueChange={(value) => setForm({ ...form, kind: value as TriggerKind })}>
                <SelectTrigger aria-label="触发方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">手动运行</SelectItem>
                  <SelectItem value="once">单次时间</SelectItem>
                  <SelectItem value="schedule">周期时间</SelectItem>
                  <SelectItem value="file">工作区文件变化</SelectItem>
                  <SelectItem value="url">公开网址变化</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <TriggerFields form={form} setForm={setForm} />
            <p className="text-xs text-muted-foreground">
              周期、文件和网址监控会在任务真正启用前要求确认。每次运行沿用当前模型、任务权限与审批边界。
            </p>
          </CardContent>
          <div className="flex items-center gap-2 border-t px-6 py-4">
            <Button disabled={!form.name.trim() || !form.prompt.trim() || busy !== null} onClick={() => void save()}>
              {busy === 'save' ? <RefreshCw className="animate-spin" /> : editing ? <Check /> : <Plus />}
              {editing ? '保存修改' : '创建自动化'}
            </Button>
            {editing && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setForm(emptyForm());
                }}
              >
                <X data-icon="inline-start" />
                取消修改
              </Button>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <header className="flex items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">我的自动化</h1>
              <p className="mt-1 text-sm text-muted-foreground">手动、定时和文件变化任务都在这里管理。</p>
            </div>
            <Button variant="outline" onClick={() => void load()}>
              <RefreshCw data-icon="inline-start" />
              刷新
            </Button>
          </header>
          {automations.length === 0 && (
            <Empty>
              <EmptyHeader>
                <CalendarClock />
                <EmptyTitle>还没有自动化</EmptyTitle>
                <EmptyDescription>从左侧创建一个单次任务或周期任务。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {automations.map((item) => {
            const history = recent.get(item.id) ?? [];
            const last = history[0];
            return (
              <Card key={item.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {item.name}
                    <Badge variant={item.approval === 'pending' ? 'destructive' : item.state === 'active' ? 'secondary' : 'outline'}>
                      {item.approval === 'pending' ? '待确认' : (stateLabel[item.state] ?? item.state)}
                    </Badge>
                  </CardTitle>
                  <CardDescription>{item.prompt}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <span className="flex items-center gap-1.5">
                      {item.trigger.type === 'url' ? <Link2 /> : item.trigger.type === 'file' ? <FileClock /> : <Clock3 />}
                      {triggerLabel(item.trigger)}
                    </span>
                    <span>下次：{dateTime(item.nextDueAt)}</span>
                    <span>上次：{last ? `${stateLabel[last.state] ?? last.state} · ${dateTime(last.dueAt)}` : '尚未运行'}</span>
                    <span className="truncate">
                      {last?.runMissing ? '运行记录已删除' : (last?.reason ?? last?.run?.error ?? '没有执行错误')}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.approval === 'pending' && (
                      <Button
                        size="sm"
                        disabled={busy === item.id}
                        onClick={() => void action(item.id, () => automationApi.confirm(item.id, item.revision), '自动化已确认')}
                      >
                        <Check data-icon="inline-start" />
                        确认
                      </Button>
                    )}
                    {item.state === 'active' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === item.id}
                        onClick={() => void action(item.id, () => automationApi.run(item.id, item.revision), '已创建运行')}
                      >
                        <Play data-icon="inline-start" />
                        立即运行
                      </Button>
                    )}
                    {item.state === 'active' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === item.id}
                        onClick={() => void action(item.id, () => automationApi.pause(item.id, item.revision), '已暂停')}
                      >
                        <Pause data-icon="inline-start" />
                        暂停
                      </Button>
                    ) : (
                      item.state === 'paused' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === item.id}
                          onClick={() => void action(item.id, () => automationApi.resume(item.id, item.revision), '已恢复')}
                        >
                          <TimerReset data-icon="inline-start" />
                          恢复
                        </Button>
                      )
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(item);
                        setForm(toForm(item));
                      }}
                    >
                      <Pencil data-icon="inline-start" />
                      修改
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === item.id}
                      onClick={() => void action(item.id, () => automationApi.cancel(item.id, item.revision), '已取消')}
                    >
                      <Trash2 data-icon="inline-start" />
                      取消
                    </Button>
                  </div>
                  {history.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">执行历史 · {history.length}</summary>
                      <div className="mt-2 flex flex-col gap-1">
                        {history.slice(0, 8).map((occurrence) => (
                          <div key={occurrence.id} className="flex items-center gap-2 rounded p-2 text-xs hover:bg-muted">
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                              disabled={!occurrence.run}
                              onClick={() => occurrence.run && onSession(occurrence.run.sessionId)}
                            >
                              <Badge variant="outline">{stateLabel[occurrence.state] ?? occurrence.state}</Badge>
                              <span>{dateTime(occurrence.dueAt)}</span>
                              <span className="min-w-0 flex-1 truncate">
                                {occurrence.runMissing ? '运行记录已删除' : (occurrence.run?.error ?? occurrence.reason ?? '执行完成')}
                              </span>
                              {occurrence.run && <span>{runLabels[occurrence.run.status as RunStatus] ?? occurrence.run.status}</span>}
                            </button>
                            {occurrence.run && ['queued', 'running', 'waiting_approval'].includes(occurrence.run.status) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy === `${item.id}:${occurrence.runId}`}
                                onClick={() =>
                                  void action(
                                    `${item.id}:${occurrence.runId}`,
                                    () => automationApi.cancelRun(item.id, occurrence.runId!),
                                    '已请求停止本次运行',
                                  )
                                }
                              >
                                <Square data-icon="inline-start" />
                                停止本次
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </main>
    </ScrollArea>
  );
}
