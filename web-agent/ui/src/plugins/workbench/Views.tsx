import { useState } from 'react';
import { ArrowUpRight, Lightbulb, Plus, Trash2, X } from 'lucide-react';
import { day, live, noteToTask, todayTask } from '../../../../plugins/workbench/model';
import { Choice, NoItems, useWorkbench } from './shared';
import { TaskRow, type Preferences } from './Tasks';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ItemGroup } from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';

export function Focus({ prefs, setPrefs }: { prefs: Preferences; setPrefs: (patch: Partial<Preferences>) => void }) {
  const { data, store, L, edit } = useWorkbench(),
    today = day();
  const overdue = data.tasks
    .filter((task) => live(task) && !!task.due && task.due < today)
    .sort((a, b) => a.due.localeCompare(b.due) || a.prio - b.prio);
  const todayList = data.tasks.filter((task) => todayTask(task)).sort((a, b) => Number(a.done) - Number(b.done) || a.prio - b.prio);
  const remaining = todayList.filter(live),
    done = todayList.filter((task) => task.done);
  const blocked = data.projects.filter((project) => project.status === 'blocked');
  const pomos = remaining.reduce((sum, task) => sum + Math.max(0, task.est - task.pomo), 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          [L('今日待办', 'To do today'), remaining.length],
          [L('逾期待办', 'Overdue'), overdue.length],
          [L('今日完成', 'Completed today'), done.length],
          [L('专注番茄', 'Pomodoros today'), data.meta.pomoLog[today] || 0],
        ].map(([label, value]) => (
          <Card key={label} size="sm">
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      {!prefs.nudgeHidden && (remaining.length > 6 || pomos > 12) && (
        <Alert>
          <Lightbulb />
          <AlertTitle>{L('给今天留一点余地', 'Leave some room today')}</AlertTitle>
          <AlertDescription>
            {L(
              `今天有 ${remaining.length} 项待办，预计还需 ${pomos} 个番茄。可以将低优先级任务顺延。`,
              `${remaining.length} tasks today, with ${pomos} estimated pomodoros remaining. Consider rescheduling lower priorities.`,
            )}
          </AlertDescription>
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label={L('隐藏提醒', 'Dismiss')} onClick={() => setPrefs({ nudgeHidden: true })}>
              <X />
            </Button>
          </AlertAction>
        </Alert>
      )}
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {!!overdue.length && (
            <Card>
              <CardHeader>
                <CardTitle>{L('逾期', 'Overdue')}</CardTitle>
                <CardDescription>{L('完成，或重新安排一个日期。', 'Complete these or choose a new date.')}</CardDescription>
                <CardAction>
                  <Badge variant="destructive">{overdue.length}</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <ItemGroup className="gap-2">
                  {overdue.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </ItemGroup>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>{L('今天要处理的', 'Today’s focus')}</CardTitle>
              <CardDescription>{today}</CardDescription>
              <CardAction>
                <Button size="sm" variant="outline" onClick={() => edit({ kind: 'task' })}>
                  <Plus data-icon="inline-start" />
                  {L('新建', 'New')}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <ItemGroup className="gap-2">
                {todayList
                  .filter((task) => !overdue.some((item) => item.id === task.id))
                  .map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
              </ItemGroup>
              {!todayList.length && <NoItems />}
            </CardContent>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{L('每日一记', 'Daily line')}</CardTitle>
              <CardDescription>{today}</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="workbench-diary" className="sr-only">
                    {L('每日一记', 'Daily line')}
                  </FieldLabel>
                  <Textarea
                    id="workbench-diary"
                    rows={5}
                    value={data.diary[today] || ''}
                    placeholder={L('今天最值得记住的一件事…', 'One thing worth remembering today…')}
                    onChange={(event) =>
                      store.commit((draft) => {
                        draft.diary[today] = event.target.value;
                        draft.diaryTs[today] = Date.now();
                      }, false)
                    }
                  />
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{L('受阻项目', 'Blocked projects')}</CardTitle>
              <CardDescription>{L('卡点与下一步', 'Blockers and next steps')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {blocked.map((project) => (
                <Alert key={project.id}>
                  <AlertTitle>
                    <Button variant="link" className="h-auto p-0" onClick={() => edit({ kind: 'proj', id: project.id })}>
                      {project.name}
                    </Button>
                  </AlertTitle>
                  <AlertDescription>
                    {project.blocker}
                    {project.next && (
                      <p>
                        {L('下一步：', 'Next: ')}
                        {project.next}
                      </p>
                    )}
                  </AlertDescription>
                </Alert>
              ))}
              {!blocked.length && <p className="text-sm text-muted-foreground">{L('暂无受阻项目', 'No blocked projects')}</p>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
export function Notes() {
  const { data, store, L, edit, remove } = useWorkbench();
  const [query, setQuery] = useState(''),
    [tag, setTag] = useState('all');
  const tags = [...new Set(data.notes.flatMap((note) => note.tags))];
  const notes = data.notes
    .filter(
      (note) =>
        (tag === 'all' || note.tags.includes(tag)) && `${note.text} ${note.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="min-w-0 flex-1"
          aria-label={L('搜索灵感', 'Search notes')}
          placeholder={L('搜索灵感…', 'Search notes…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="w-40">
          <Choice
            label={L('灵感标签', 'Note tags')}
            value={tag}
            onChange={setTag}
            options={[['all', L('全部标签', 'All tags')], ...tags.map((value) => [value, value] as [string, string])]}
          />
        </div>
        <Button onClick={() => edit({ kind: 'note' })}>
          <Plus data-icon="inline-start" />
          {L('记录灵感', 'New note')}
        </Button>
      </div>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {notes.map((note) => (
          <Card key={note.id}>
            <CardHeader>
              <CardTitle>{L('灵感', 'Note')}</CardTitle>
              <CardDescription>{new Date(note.createdAt).toLocaleDateString()}</CardDescription>
              <CardAction>
                <Button variant="ghost" size="icon-xs" aria-label={L('删除灵感', 'Delete note')} onClick={() => remove('note', [note.id])}>
                  <Trash2 />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start whitespace-pre-wrap p-0 text-left"
                onClick={() => edit({ kind: 'note', id: note.id })}
              >
                {note.text}
              </Button>
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              {note.tags.map((value) => (
                <Badge key={value} variant="secondary">
                  #{value}
                </Badge>
              ))}
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => store.commit((draft) => noteToTask(draft, note))}>
                <ArrowUpRight data-icon="inline-start" />
                {L('转为任务', 'Convert to task')}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      {!notes.length && <NoItems />}
    </div>
  );
}
export function Projects() {
  const { data, store, L, edit, remove } = useWorkbench();
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('all');
  const projects = data.projects.filter(
    (project) =>
      (status === 'all' || project.status === status) &&
      `${project.name} ${project.stage} ${project.next} ${project.blocker}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="min-w-0 flex-1"
          aria-label={L('搜索项目', 'Search projects')}
          placeholder={L('搜索项目…', 'Search projects…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="w-40">
          <Choice
            label={L('项目状态筛选', 'Project status filter')}
            value={status}
            onChange={setStatus}
            options={[
              ['all', L('全部状态', 'All statuses')],
              ['active', L('进行中', 'Active')],
              ['blocked', L('受阻', 'Blocked')],
              ['done', L('已完成', 'Done')],
            ]}
          />
        </div>
        <Button onClick={() => edit({ kind: 'proj' })}>
          <Plus data-icon="inline-start" />
          {L('新建项目', 'New project')}
        </Button>
      </div>
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
        {projects.map((project) => {
          const tasks = data.tasks.filter((task) => task.pid === project.id),
            done = tasks.filter((task) => task.done).length;
          return (
            <Card key={project.id}>
              <CardHeader>
                <CardTitle>
                  <Button
                    variant="link"
                    className="h-auto justify-start whitespace-normal p-0 text-left"
                    onClick={() => edit({ kind: 'proj', id: project.id })}
                  >
                    {project.name}
                  </Button>
                </CardTitle>
                <CardDescription>{project.stage || L('尚未设置阶段', 'No stage set')}</CardDescription>
                <CardAction>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${L('删除项目', 'Delete project')} ${project.name}`}
                    onClick={() => remove('proj', [project.id])}
                  >
                    <Trash2 />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <Choice
                  value={project.status}
                  label={`${project.name} ${L('状态', 'status')}`}
                  onChange={(next) =>
                    store.commit((draft) => {
                      const item = draft.projects.find((p) => p.id === project.id);
                      if (item) {
                        item.status = next;
                        item.updatedAt = Date.now();
                        item._s = false;
                      }
                    })
                  }
                  options={[
                    ['active', L('进行中', 'Active')],
                    ['blocked', L('受阻', 'Blocked')],
                    ['done', L('已完成', 'Done')],
                  ]}
                />
                {project.next && (
                  <p className="text-sm">
                    {L('下一步：', 'Next: ')}
                    {project.next}
                  </p>
                )}
                {project.blocker && (
                  <Alert>
                    <AlertTitle>{L('阻塞原因', 'Blocker')}</AlertTitle>
                    <AlertDescription>{project.blocker}</AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>{L('任务进度', 'Task progress')}</span>
                    <span>
                      {done}/{tasks.length}
                    </span>
                  </div>
                  <Progress aria-label={L('任务进度', 'Task progress')} value={tasks.length ? (done / tasks.length) * 100 : 0} />
                </div>
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="outline" size="sm">
                      {L('关联任务', 'Linked tasks')} · {tasks.length}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-3">
                    <ItemGroup className="gap-2">
                      {tasks.map((task) => (
                        <TaskRow key={task.id} task={task} />
                      ))}
                    </ItemGroup>
                    {!tasks.length && <NoItems />}
                  </CollapsibleContent>
                </Collapsible>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {!projects.length && <NoItems />}
    </div>
  );
}
