import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { zhCN, enUS } from 'date-fns/locale';
import { Check, ChevronDown, GripVertical, Pencil, Plus, Search, Timer, Trash2 } from 'lucide-react';
import { day, live, parseQuick, shift, taskDefaults, todayTask, toggleTask, type Task } from '../../../../plugins/workbench/model';
import { Choice, NoItems, useWorkbench } from './shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export interface Preferences {
  taskView: string;
  boardGroup: string;
  navCollapsed: boolean;
  qaOpen: boolean;
  pomoMin: number;
  pomoBreak: number;
  nudgeHidden: boolean;
  taskSort: string;
  [key: string]: unknown;
}
export function TaskRow({
  task,
  draggable = false,
  selected,
  select,
}: {
  task: Task;
  draggable?: boolean;
  selected?: boolean;
  select?: (checked: boolean) => void;
}) {
  const { data, store, L, edit, remove, startPomo } = useWorkbench();
  const drag = useDraggable({ id: task.id, disabled: !draggable });
  const [renaming, setRenaming] = useState(false),
    [title, setTitle] = useState(task.title),
    cancel = useRef(false);
  const project = data.projects.find((p) => p.id === task.pid);
  const rename = () => {
    if (!cancel.current && title.trim() && title.trim() !== task.title)
      store.commit((draft) => {
        const item = draft.tasks.find((x) => x.id === task.id);
        if (item) {
          item.title = title.trim();
          item.updatedAt = Date.now();
          item._s = false;
        }
      });
    cancel.current = false;
    setRenaming(false);
  };
  return (
    <Collapsible
      ref={drag.setNodeRef}
      data-testid="workbench-task"
      data-task-id={task.id}
      className={cn('min-w-0', drag.isDragging && 'opacity-40')}
    >
      <Item variant="outline" size="sm" className="items-start">
        {draggable && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${L('拖动', 'Drag')} ${task.title}`}
            className="touch-none"
            {...drag.attributes}
            {...drag.listeners}
          >
            <GripVertical />
          </Button>
        )}
        {select ? (
          <Checkbox
            checked={selected}
            aria-label={`${L('选择', 'Select')} ${task.title}`}
            onCheckedChange={(checked) => select(!!checked)}
          />
        ) : (
          <Checkbox
            checked={task.done}
            aria-label={`${L('完成', 'Complete')} ${task.title}`}
            onCheckedChange={() => store.commit((draft) => toggleTask(draft, task.id))}
          />
        )}
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            {renaming ? (
              <Input
                autoFocus
                aria-label={L('任务标题', 'Task title')}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={rename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    cancel.current = true;
                    event.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <Button
                variant="link"
                className={cn('h-auto max-w-full justify-start whitespace-normal p-0 text-left', task.done && 'line-through')}
                onClick={() => edit({ kind: 'task', id: task.id })}
              >
                {task.title}
              </Button>
            )}
          </ItemTitle>
          <ItemDescription className="flex flex-wrap items-center gap-1.5">
            <Badge variant={live(task) && task.prio === 1 ? 'destructive' : 'outline'}>P{task.prio}</Badge>
            {task.due && (
              <Badge variant={live(task) && task.due < day() ? 'destructive' : 'secondary'}>
                {task.start ? task.start + ' → ' : ''}
                {task.due}
              </Badge>
            )}
            {project && <Badge variant="outline">{project.name}</Badge>}
            {task.status !== 'todo' && !task.done && (
              <Badge variant="secondary">
                {task.status === 'doing'
                  ? L('进行中', 'In progress')
                  : task.status === 'wait'
                    ? L('等待中', 'Waiting')
                    : L('已取消', 'Cancelled')}
              </Badge>
            )}
            {task.repeat && (
              <Badge variant="outline">
                {(
                  {
                    daily: L('每天', 'Daily'),
                    weekdays: L('工作日', 'Weekdays'),
                    weekly: L('每周', 'Weekly'),
                    monthly: L('每月', 'Monthly'),
                  } as Record<string, string>
                )[task.repeat] || task.repeat}
              </Badge>
            )}
            {(task.est > 0 || task.pomo > 0) && (
              <Badge variant="outline">
                {L('番茄', 'Pomo')} {task.pomo}
                {task.est ? '/' + task.est : ''}
              </Badge>
            )}
            {task.rolls > 0 && (
              <Badge variant="outline">
                {L('顺延', 'Carried')} {task.rolls}
              </Badge>
            )}
            {task.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                #{tag}
              </Badge>
            ))}
            {!!task.subs.length && (
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="xs">
                  {task.subs.filter((sub) => sub.d).length}/{task.subs.length}
                  <ChevronDown data-icon="inline-end" />
                </Button>
              </CollapsibleTrigger>
            )}
            {task.link && (
              <Button asChild variant="link" size="xs">
                <a
                  href={
                    ['http://', 'https://', 'mailto:'].some((prefix) => task.link.toLowerCase().startsWith(prefix))
                      ? task.link
                      : 'https://' + task.link
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {L('链接', 'Link')}
                </a>
              </Button>
            )}
          </ItemDescription>
          {task.note && <ItemDescription className="line-clamp-2">{task.note}</ItemDescription>}
        </ItemContent>
        <ItemActions className="ml-auto flex-wrap">
          {!task.done && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${L('开始专注', 'Focus on')} ${task.title}`}
              onClick={() => startPomo(task.id)}
            >
              <Timer />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${L('行内编辑', 'Rename')} ${task.title}`}
            onClick={() => {
              setTitle(task.title);
              setRenaming(true);
            }}
          >
            <Pencil />
          </Button>
          {live(task) && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() =>
                store.commit((draft) => {
                  const item = draft.tasks.find((x) => x.id === task.id);
                  if (item) {
                    item.due = shift(item.due && item.due > day() ? item.due : day(), 1);
                    item.updatedAt = Date.now();
                  }
                })
              }
            >
              +1{L('天', 'd')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${L('删除', 'Delete')} ${task.title}`}
            onClick={() => remove('task', [task.id])}
          >
            <Trash2 />
          </Button>
        </ItemActions>
      </Item>
      {!!task.subs.length && (
        <CollapsibleContent>
          <FieldGroup className="gap-2 px-5 py-3">
            {task.subs.map((sub, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 子任务复用同一字段组，位置即身份
              <Field key={index} orientation="horizontal">
                <Checkbox
                  checked={sub.d}
                  aria-label={sub.t}
                  onCheckedChange={(checked) =>
                    store.commit((draft) => {
                      const item = draft.tasks.find((x) => x.id === task.id);
                      if (item) {
                        item.subs[index].d = !!checked;
                        item.updatedAt = Date.now();
                      }
                    })
                  }
                />
                <span className={cn('text-sm', sub.d && 'text-muted-foreground line-through')}>{sub.t}</span>
              </Field>
            ))}
          </FieldGroup>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
function DropColumn({ id, title, tasks }: { id: string; title: string; tasks: Task[] }) {
  const drop = useDroppable({ id });
  return (
    <section
      ref={drop.setNodeRef}
      data-drop-id={id}
      className={cn('flex min-h-44 min-w-0 flex-col gap-3 rounded-xl bg-muted/40 p-3', drop.isOver && 'ring-2 ring-ring')}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="secondary">{tasks.length}</Badge>
      </div>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} draggable />
      ))}
      {!tasks.length && <NoItems />}
    </section>
  );
}
function DropDay(props: ComponentProps<typeof CalendarDayButton>) {
  const drop = useDroppable({ id: 'date:' + day(props.day.date) });
  const { data } = useWorkbench();
  const count = data.tasks.filter((task) => live(task) && task.due === day(props.day.date)).length;
  return (
    <div ref={drop.setNodeRef} className={cn(drop.isOver && 'rounded-md ring-2 ring-ring')}>
      <CalendarDayButton {...props}>
        {props.day.date.getDate()}
        {count > 0 && <span>{count} ·</span>}
      </CalendarDayButton>
    </div>
  );
}
export default function Tasks({ prefs, setPrefs }: { prefs: Preferences; setPrefs: (patch: Partial<Preferences>) => void }) {
  const { data, store, L, english, edit, remove } = useWorkbench();
  const [filter, setFilter] = useState('today'),
    [query, setQuery] = useState(''),
    [project, setProject] = useState('all'),
    [tag, setTag] = useState('all');
  const [quick, setQuick] = useState(''),
    [batch, setBatch] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [batchDate, setBatchDate] = useState('');
  const [selectedDay, setSelectedDay] = useState<Date | undefined>(new Date()),
    [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }), useSensor(KeyboardSensor));
  const today = day(),
    keyword = query.trim().toLowerCase();
  const scope = data.tasks.filter(
    (task) =>
      (project === 'all' || (project === 'none' ? !task.pid : task.pid === project)) &&
      (tag === 'all' || task.tags.includes(tag)) &&
      (!keyword ||
        `${task.title} ${task.note} ${task.link} ${task.tags.join(' ')} ${task.subs.map((sub) => sub.t).join(' ')} ${data.projects.find((p) => p.id === task.pid)?.name || ''}`
          .toLowerCase()
          .includes(keyword)),
  );
  const order = (left: Task, right: Task) => {
    if (prefs.taskSort === 'new') return right.createdAt - left.createdAt;
    if (prefs.taskSort === 'title') return left.title.localeCompare(right.title, english ? 'en' : 'zh');
    if (prefs.taskSort === 'due') return (left.due || '9').localeCompare(right.due || '9') || left.prio - right.prio;
    return Number(left.done) - Number(right.done) || left.prio - right.prio || (left.due || '9').localeCompare(right.due || '9');
  };
  const list = scope
    .filter((task) =>
      filter === 'today'
        ? todayTask(task)
        : filter === 'overdue'
          ? live(task) && !!task.due && task.due < today
          : filter === 'upcoming'
            ? live(task) && (!task.due || (task.due > today && !(task.start && task.start <= today)))
            : filter === 'done'
              ? task.done
              : true,
    )
    .sort(prefs.taskSort === 'def' && filter === 'done' ? (a, b) => (b.doneAt || 0) - (a.doneAt || 0) : order);
  const active = scope.filter(live).sort(order),
    visible = prefs.taskView === 'list' ? list : active;
  const ids = selected.filter((id) => data.tasks.some((task) => task.id === id));
  const updateBatch = (patch: Partial<Task>) =>
    store.commit((draft) =>
      draft.tasks.forEach((task) => {
        if (ids.includes(task.id)) Object.assign(task, patch, { updatedAt: Date.now(), _s: false });
      }),
    );
  const groups: [string, string, Task[]][] =
    prefs.taskView === 'matrix' || prefs.boardGroup === 'prio'
      ? [1, 2, 3, 4].map((prio, index) => [
          `prio:${prio}`,
          [
            L('P1 紧急且重要', 'P1 Urgent and important'),
            L('P2 重要不紧急', 'P2 Important, not urgent'),
            L('P3 紧急不重要', 'P3 Urgent, not important'),
            L('P4 一般', 'P4 Low priority'),
          ][index],
          active.filter((task) => task.prio === prio),
        ])
      : prefs.boardGroup === 'proj'
        ? [
            ['proj:', L('未关联', 'Unlinked'), active.filter((task) => !task.pid)],
            ...data.projects.map((p) => [`proj:${p.id}`, p.name, active.filter((task) => task.pid === p.id)] as [string, string, Task[]]),
          ]
        : [
            ['tag:', L('无标签', 'Untagged'), active.filter((task) => !task.tags.length)],
            ...[...new Set(active.flatMap((task) => task.tags))].map(
              (label) => [`tag:${label}`, label, active.filter((task) => task.tags.includes(label))] as [string, string, Task[]],
            ),
          ];
  const drop = ({ active: source, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const [kind, ...values] = String(over.id).split(':'),
      value = values.join(':');
    store.commit((draft) => {
      const task = draft.tasks.find((item) => item.id === source.id);
      if (!task) return;
      if (kind === 'prio') task.prio = Number(value);
      else if (kind === 'proj') task.pid = value;
      else if (kind === 'tag') task.tags = value ? [...new Set([...task.tags, value])] : [];
      else if (kind === 'date') task.due = value;
      else return;
      task.updatedAt = Date.now();
      task._s = false;
    });
  };
  const viewOptions = [
    ['list', L('列表', 'List')],
    ['board', L('看板', 'Board')],
    ['matrix', L('四象限', 'Matrix')],
    ['timeline', L('时间轴', 'Timeline')],
    ['month', L('月历', 'Calendar')],
  ];
  let content: ReactNode;
  if (prefs.taskView === 'board' || prefs.taskView === 'matrix')
    content = (
      <div className={cn('grid min-w-0 gap-4', prefs.taskView === 'matrix' ? 'lg:grid-cols-2' : 'xl:grid-cols-2 2xl:grid-cols-4')}>
        {groups.map(([id, title, tasks]) => (
          <DropColumn key={id} id={id} title={title} tasks={tasks} />
        ))}
      </div>
    );
  else if (prefs.taskView === 'timeline')
    content = (
      <div className="flex flex-col gap-5">
        {[...new Set(active.map((task) => task.start || task.due || ''))]
          .sort((a, b) => (a || '9').localeCompare(b || '9'))
          .map((date) => (
            <Card key={date}>
              <CardHeader>
                <CardTitle>{date || L('尚未安排', 'Unscheduled')}</CardTitle>
                <CardDescription>{L('开始与截止日期', 'Start and due dates')}</CardDescription>
              </CardHeader>
              <CardContent>
                <ItemGroup className="gap-2">
                  {active
                    .filter((task) => (task.start || task.due || '') === date)
                    .map((task) => (
                      <TaskRow key={task.id} task={task} />
                    ))}
                </ItemGroup>
              </CardContent>
            </Card>
          ))}
        {!active.length && <NoItems />}
      </div>
    );
  else if (prefs.taskView === 'month')
    content = (
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(17rem,24rem)_1fr]">
        <Card>
          <CardContent>
            <Calendar
              mode="single"
              selected={selectedDay}
              onSelect={setSelectedDay}
              locale={english ? enUS : zhCN}
              components={{ DayButton: DropDay }}
              className="w-full [--cell-size:--spacing(9)]"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{selectedDay ? day(selectedDay) : L('选择日期', 'Select a date')}</CardTitle>
            <CardDescription>{L('将任务拖到日期，调整截止日。', 'Drag tasks onto a day to reschedule.')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {active
              .filter(
                (task) =>
                  selectedDay &&
                  (task.due === day(selectedDay) || (!!task.start && task.start <= day(selectedDay) && task.due >= day(selectedDay))),
              )
              .map((task) => (
                <TaskRow key={task.id} task={task} draggable />
              ))}
            <Button variant="outline" onClick={() => edit({ kind: 'task' })}>
              <Plus data-icon="inline-start" />
              {L('新建任务', 'New task')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  else
    content = (
      <ItemGroup className="gap-2">
        {list.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            select={
              batch
                ? (checked) =>
                    setSelected((current) => (checked ? [...new Set([...current, task.id])] : current.filter((id) => id !== task.id)))
                : undefined
            }
            selected={ids.includes(task.id)}
          />
        ))}
        {!list.length && <NoItems />}
      </ItemGroup>
    );
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!quick.trim()) return;
          store.commit((draft) => {
            draft.tasks.unshift({ ...taskDefaults(parseQuick(quick, draft.projects)), _s: false });
            draft.meta.sample = false;
          });
          setQuick('');
          setFilter('all');
        }}
      >
        <InputGroup>
          <InputGroupInput
            aria-label={L('快速添加任务', 'Quick add task')}
            value={quick}
            onChange={(event) => setQuick(event.target.value)}
            placeholder={L('做什么？明天 !1 #项目 ~2', 'What needs doing? tomorrow !1 #project ~2')}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton type="submit" disabled={!quick.trim()}>
              <Plus />
              {L('添加', 'Add')}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={prefs.taskView} onValueChange={(taskView) => setPrefs({ taskView })}>
          <TabsList>
            {viewOptions.map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {prefs.taskView === 'list' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setBatch(!batch);
                setSelected([]);
              }}
            >
              {batch ? L('退出批选', 'Exit selection') : L('批量选择', 'Select tasks')}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => edit({ kind: 'task' })}>
            {L('详细新建', 'New with details')}
          </Button>
        </div>
      </div>
      <FieldGroup className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Field className="col-span-2 lg:col-span-1">
          <FieldLabel className="sr-only">{L('搜索任务', 'Search tasks')}</FieldLabel>
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={L('搜索任务', 'Search tasks')}
              placeholder={L('搜索任务、标签、子任务…', 'Search tasks, tags, subtasks…')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
        </Field>
        <Field>
          <FieldLabel className="sr-only">{L('项目筛选', 'Filter project')}</FieldLabel>
          <Choice
            label={L('项目筛选', 'Filter project')}
            value={project}
            onChange={setProject}
            options={[
              ['all', L('全部项目', 'All projects')],
              ['none', L('未关联项目', 'Unlinked')],
              ...data.projects.map((p) => [p.id, p.name] as [string, string]),
            ]}
          />
        </Field>
        <Field>
          <FieldLabel className="sr-only">{L('标签筛选', 'Filter tags')}</FieldLabel>
          <Choice
            label={L('标签筛选', 'Filter tags')}
            value={tag}
            onChange={setTag}
            options={[
              ['all', L('全部标签', 'All tags')],
              ...[...new Set(data.tasks.flatMap((task) => task.tags))].map((label) => [label, label] as [string, string]),
            ]}
          />
        </Field>
        <Field>
          <FieldLabel className="sr-only">{L('排序', 'Sort')}</FieldLabel>
          {prefs.taskView === 'board' ? (
            <Choice
              label={L('看板分组', 'Group board')}
              value={prefs.boardGroup}
              onChange={(boardGroup) => setPrefs({ boardGroup })}
              options={[
                ['prio', L('按优先级', 'By priority')],
                ['proj', L('按项目', 'By project')],
                ['tag', L('按标签', 'By tag')],
              ]}
            />
          ) : (
            <Choice
              label={L('排序', 'Sort')}
              value={prefs.taskSort}
              onChange={(taskSort) => setPrefs({ taskSort })}
              options={[
                ['def', L('默认排序', 'Default order')],
                ['prio', L('按优先级', 'By priority')],
                ['due', L('按截止日', 'By due date')],
                ['new', L('最新创建', 'Newest first')],
                ['title', L('按标题', 'By title')],
              ]}
            />
          )}
        </Field>
      </FieldGroup>
      {prefs.taskView === 'list' && (
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList variant="line">
            {[
              ['today', L('今天', 'Today')],
              ['overdue', L('逾期', 'Overdue')],
              ['upcoming', L('未来', 'Upcoming')],
              ['all', L('全部', 'All')],
              ['done', L('已完成', 'Done')],
            ].map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {(project !== 'all' || tag !== 'all' || query) && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {L('已筛选', 'Filtered')} · {visible.length}
          </Badge>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setProject('all');
              setTag('all');
              setQuery('');
            }}
          >
            {L('清除筛选', 'Clear filters')}
          </Button>
        </div>
      )}
      {batch && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>
              {L('已选择', 'Selected')} {ids.length}
            </CardTitle>
            <CardDescription>{L('批量更新任务', 'Update selected tasks')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <FieldGroup className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Field orientation="horizontal">
                <Checkbox
                  aria-label={L('全选当前列表', 'Select visible tasks')}
                  checked={!!list.length && list.every((task) => ids.includes(task.id))}
                  onCheckedChange={(checked) => setSelected(checked ? list.map((task) => task.id) : [])}
                />
                <FieldLabel>{L('全选当前列表', 'Select visible')}</FieldLabel>
              </Field>
              <Field>
                <Choice
                  disabled={!ids.length}
                  label={L('批量优先级', 'Batch priority')}
                  value=""
                  onChange={(prio) => updateBatch({ prio: Number(prio) })}
                  options={[
                    ['', L('设置优先级', 'Set priority')],
                    ...[1, 2, 3, 4].map((prio) => [String(prio), 'P' + prio] as [string, string]),
                  ]}
                />
              </Field>
              <Field>
                <Choice
                  disabled={!ids.length}
                  label={L('批量项目', 'Batch project')}
                  value="select"
                  onChange={(pid) => updateBatch({ pid })}
                  options={[
                    ['select', L('设置项目', 'Set project')],
                    ['', L('未关联', 'Unlinked')],
                    ...data.projects.map((p) => [p.id, p.name] as [string, string]),
                  ]}
                />
              </Field>
              <Field>
                <Input
                  type="date"
                  aria-label={L('批量日期', 'Batch due date')}
                  value={batchDate}
                  onChange={(event) => setBatchDate(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={!ids.length} onClick={() => updateBatch({ due: batchDate })}>
                {L('设置日期', 'Set date')}
              </Button>
              <Button variant="outline" size="sm" disabled={!ids.length} onClick={() => updateBatch({ done: true, doneAt: Date.now() })}>
                <Check data-icon="inline-start" />
                {L('完成', 'Complete')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!ids.length}
                onClick={() => {
                  remove('task', ids);
                  setSelected([]);
                }}
              >
                <Trash2 data-icon="inline-start" />
                {L('删除', 'Delete')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <DndContext
        sensors={sensors}
        onDragStart={(event) => setDragging(String(event.active.id))}
        onDragEnd={drop}
        onDragCancel={() => setDragging(null)}
      >
        {content}
        <DragOverlay>
          {dragging && (
            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>{data.tasks.find((task) => task.id === dragging)?.title}</CardTitle>
              </CardHeader>
            </Card>
          )}
        </DragOverlay>
      </DndContext>
      {filter === 'done' && prefs.taskView === 'list' && !!list.length && (
        <Button
          variant="outline"
          className="self-start"
          onClick={() =>
            remove(
              'task',
              list.map((task) => task.id),
            )
          }
        >
          {L('清理已完成', 'Clear completed')}
        </Button>
      )}
    </div>
  );
}
