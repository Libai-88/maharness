import { useId, useState, type FormEvent } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { taskDefaults, uid, type Note, type Project, type Task } from '../../../../plugins/workbench/model';
import { useWorkbench, Choice, type Editor } from './shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '@/components/ui/sheet';

export default function RecordEditor({ editor, close }: { editor: Editor; close: () => void }) {
  const { data, store, L, remove } = useWorkbench(),
    prefix = useId();
  const source =
    editor.kind === 'task'
      ? data.tasks.find((x) => x.id === editor.id)
      : editor.kind === 'note'
        ? data.notes.find((x) => x.id === editor.id)
        : data.projects.find((x) => x.id === editor.id);
  const [task, setTask] = useState<Task>(() => taskDefaults(editor.kind === 'task' ? (source as Task) : {}));
  const [note, setNote] = useState<Note>(() =>
    editor.kind === 'note' && source
      ? ({ ...source } as Note)
      : { id: uid(), text: '', tags: [], createdAt: Date.now(), updatedAt: Date.now() },
  );
  const [project, setProject] = useState<Project>(() =>
    editor.kind === 'proj' && source
      ? ({ ...source } as Project)
      : { id: uid(), name: '', stage: '', next: '', blocker: '', status: 'active', updatedAt: Date.now() },
  );
  const [tags, setTags] = useState(() => (editor.kind === 'task' ? task.tags : note.tags).join(', '));
  const [attempted, setAttempted] = useState(false);
  const fieldId = (name: string) => prefix + '-' + name;
  const title = editor.kind === 'task' ? L('任务', 'Task') : editor.kind === 'note' ? L('灵感', 'Note') : L('项目', 'Project');
  const valid = !!(editor.kind === 'task' ? task.title.trim() : editor.kind === 'note' ? note.text.trim() : project.name.trim());
  const save = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!valid) return;
    store.commit((draft) => {
      const parsedTags = [
        ...new Set(
          tags
            .split(/[,，#]/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ].slice(0, 12);
      const record =
        editor.kind === 'task'
          ? { ...task, title: task.title.trim(), tags: parsedTags }
          : editor.kind === 'note'
            ? { ...note, text: note.text.trim(), tags: parsedTags }
            : { ...project, name: project.name.trim() };
      record.updatedAt = Date.now();
      record._s = false;
      const items = (editor.kind === 'task' ? draft.tasks : editor.kind === 'note' ? draft.notes : draft.projects) as (
        | Task
        | Note
        | Project
      )[];
      const index = items.findIndex((item) => item.id === record.id);
      if (index < 0) items.unshift(record);
      else items[index] = record;
      if (!editor.id) draft.meta.sample = false;
    });
    close();
  };
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent className="gap-0 sm:max-w-lg" data-testid="workbench-editor">
        <SheetHeader>
          <SheetTitle>
            {editor.id ? L('编辑', 'Edit') : L('新建', 'New')} {title}
          </SheetTitle>
          <SheetDescription>{L('保存到应用工作台。', 'Save to application storage.')}</SheetDescription>
        </SheetHeader>
        <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <FieldGroup>
              {editor.kind === 'task' && (
                <>
                  <Field data-invalid={attempted && !valid}>
                    <FieldLabel htmlFor={fieldId('title')}>{L('标题', 'Title')}</FieldLabel>
                    <Input
                      id={fieldId('title')}
                      value={task.title}
                      onChange={(event) => setTask({ ...task, title: event.target.value })}
                      required
                      autoFocus
                      aria-invalid={attempted && !valid}
                      maxLength={200}
                    />
                  </Field>
                  <FieldGroup className="grid grid-cols-2 gap-4">
                    <Field>
                      <FieldLabel>{L('优先级', 'Priority')}</FieldLabel>
                      <Choice
                        label={L('优先级', 'Priority')}
                        value={String(task.prio)}
                        onChange={(value) => setTask({ ...task, prio: Number(value) })}
                        options={[
                          ['1', L('P1 紧急且重要', 'P1 Urgent and important')],
                          ['2', L('P2 重要不紧急', 'P2 Important')],
                          ['3', L('P3 紧急不重要', 'P3 Urgent')],
                          ['4', L('P4 一般', 'P4 Low')],
                        ]}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>{L('状态', 'Status')}</FieldLabel>
                      <Choice
                        label={L('状态', 'Status')}
                        value={task.status}
                        onChange={(status) => setTask({ ...task, status })}
                        options={[
                          ['todo', L('未开始', 'To do')],
                          ['doing', L('进行中', 'In progress')],
                          ['wait', L('等待中', 'Waiting')],
                          ['cancel', L('已取消', 'Cancelled')],
                        ]}
                      />
                    </Field>
                  </FieldGroup>
                  <FieldGroup className="grid grid-cols-2 gap-4">
                    <Field>
                      <FieldLabel htmlFor={fieldId('start')}>{L('开始日期', 'Start date')}</FieldLabel>
                      <Input
                        id={fieldId('start')}
                        type="date"
                        value={task.start}
                        onChange={(event) => setTask({ ...task, start: event.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={fieldId('due')}>{L('截止日期', 'Due date')}</FieldLabel>
                      <Input
                        id={fieldId('due')}
                        type="date"
                        value={task.due}
                        min={task.start || undefined}
                        onChange={(event) => setTask({ ...task, due: event.target.value })}
                      />
                    </Field>
                  </FieldGroup>
                  <Field>
                    <FieldLabel>{L('关联项目', 'Project')}</FieldLabel>
                    <Choice
                      label={L('关联项目', 'Project')}
                      value={task.pid}
                      onChange={(pid) => setTask({ ...task, pid })}
                      options={[['', L('未关联', 'Unlinked')], ...data.projects.map((p) => [p.id, p.name] as [string, string])]}
                    />
                  </Field>
                  <FieldGroup className="grid grid-cols-2 gap-4">
                    <Field>
                      <FieldLabel>{L('重复', 'Repeat')}</FieldLabel>
                      <Choice
                        label={L('重复', 'Repeat')}
                        value={task.repeat}
                        onChange={(repeat) => setTask({ ...task, repeat })}
                        options={[
                          ['', L('不重复', 'Never')],
                          ['daily', L('每天', 'Daily')],
                          ['weekdays', L('工作日', 'Weekdays')],
                          ['weekly', L('每周', 'Weekly')],
                          ['monthly', L('每月', 'Monthly')],
                        ]}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={fieldId('est')}>{L('预计番茄数', 'Estimated pomodoros')}</FieldLabel>
                      <Input
                        id={fieldId('est')}
                        type="number"
                        min={0}
                        max={20}
                        value={task.est}
                        onChange={(event) => setTask({ ...task, est: Number(event.target.value) })}
                      />
                    </Field>
                  </FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={fieldId('link')}>{L('链接', 'Link')}</FieldLabel>
                    <Input
                      id={fieldId('link')}
                      value={task.link}
                      onChange={(event) => setTask({ ...task, link: event.target.value })}
                      maxLength={2048}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={fieldId('note')}>{L('备注', 'Notes')}</FieldLabel>
                    <Textarea
                      id={fieldId('note')}
                      value={task.note}
                      onChange={(event) => setTask({ ...task, note: event.target.value })}
                      rows={3}
                      maxLength={2000}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{L('子任务', 'Subtasks')}</FieldLabel>
                    <FieldGroup className="gap-2">
                      {task.subs.map((sub, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: 子任务复用同一字段组，位置即身份
                        <Field key={index} orientation="horizontal">
                          <Checkbox
                            checked={sub.d}
                            aria-label={`${L('完成子任务', 'Complete subtask')} ${index + 1}`}
                            onCheckedChange={(checked) =>
                              setTask({
                                ...task,
                                subs: task.subs.map((item, position) => (position === index ? { ...item, d: !!checked } : item)),
                              })
                            }
                          />
                          <Input
                            aria-label={`${L('子任务', 'Subtask')} ${index + 1}`}
                            value={sub.t}
                            maxLength={80}
                            onChange={(event) =>
                              setTask({
                                ...task,
                                subs: task.subs.map((item, position) => (position === index ? { ...item, t: event.target.value } : item)),
                              })
                            }
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={L('移除子任务', 'Remove subtask')}
                            onClick={() => setTask({ ...task, subs: task.subs.filter((_, position) => position !== index) })}
                          >
                            <X />
                          </Button>
                        </Field>
                      ))}
                    </FieldGroup>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={task.subs.length >= 9}
                      onClick={() => setTask({ ...task, subs: [...task.subs, { t: '', d: false }] })}
                    >
                      <Plus data-icon="inline-start" />
                      {L('添加子任务', 'Add subtask')}
                    </Button>
                  </Field>
                </>
              )}
              {editor.kind === 'note' && (
                <Field data-invalid={attempted && !valid}>
                  <FieldLabel htmlFor={fieldId('text')}>{L('内容', 'Content')}</FieldLabel>
                  <Textarea
                    id={fieldId('text')}
                    value={note.text}
                    onChange={(event) => setNote({ ...note, text: event.target.value })}
                    rows={9}
                    maxLength={1200}
                    required
                    autoFocus
                    aria-invalid={attempted && !valid}
                  />
                </Field>
              )}
              {editor.kind === 'proj' && (
                <>
                  <Field>
                    <FieldLabel htmlFor={fieldId('name')}>{L('项目名称', 'Project name')}</FieldLabel>
                    <Input
                      id={fieldId('name')}
                      value={project.name}
                      onChange={(event) => setProject({ ...project, name: event.target.value })}
                      required
                      autoFocus
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{L('状态', 'Status')}</FieldLabel>
                    <Choice
                      label={L('状态', 'Status')}
                      value={project.status}
                      onChange={(status) => setProject({ ...project, status })}
                      options={[
                        ['active', L('进行中', 'Active')],
                        ['blocked', L('受阻', 'Blocked')],
                        ['done', L('已完成', 'Done')],
                      ]}
                    />
                  </Field>
                  {(['stage', 'next', 'blocker'] as const).map((key, index) => (
                    <Field key={key}>
                      <FieldLabel htmlFor={fieldId(key)}>
                        {[L('当前阶段', 'Current stage'), L('下一步', 'Next step'), L('阻塞原因', 'Blocker')][index]}
                      </FieldLabel>
                      <Textarea
                        id={fieldId(key)}
                        value={project[key]}
                        onChange={(event) => setProject({ ...project, [key]: event.target.value })}
                        rows={2}
                      />
                    </Field>
                  ))}
                </>
              )}
              {editor.kind !== 'proj' && (
                <Field>
                  <FieldLabel htmlFor={fieldId('tags')}>{L('标签', 'Tags')}</FieldLabel>
                  <Input id={fieldId('tags')} value={tags} onChange={(event) => setTags(event.target.value)} />
                  <FieldDescription>{L('以逗号或 # 分隔', 'Separate with commas or #')}</FieldDescription>
                </Field>
              )}
            </FieldGroup>
          </div>
          <SheetFooter>
            {editor.id && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  remove(editor.kind, [editor.id!]);
                  close();
                }}
              >
                <Trash2 data-icon="inline-start" />
                {L('删除', 'Delete')}
              </Button>
            )}
            <Button type="submit">{L('保存', 'Save')}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
