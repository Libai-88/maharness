import { useEffect, useState } from 'react';
import { api } from '../api';
import { runsApi } from '../run-api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldLabel } from '@/components/ui/field';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface Change {
  id: string;
  workspace: string;
  state: string;
  review?: { digest: string; diff: string };
  validation?: { ok: boolean; commands: unknown[] };
}
export default function FrameworkChangesPanel({ onTask }: { onTask: (id: string, message: string) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [changes, setChanges] = useState<Change[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Change | null>(null);
  const [confirm, setConfirm] = useState<Change | null>(null);
  const refresh = () => api<Change[]>('/api/v2/framework/changes').then(setChanges);
  useEffect(() => {
    void runsApi
      .permission()
      .then((permission) => {
        setEnabled(permission.profile === 'developer');
        if (permission.profile === 'developer') void refresh().catch((error) => toast.error(String(error)));
      })
      .catch(() => undefined);
  }, []);
  const action = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      const change = await api<Change>(`/api/v2/framework/changes${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
      setSelected(change);
      await refresh();
      return change;
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!enabled) return null;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          框架修改
        </Button>
      </SheetTrigger>
      <SheetContent className="gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>框架修改</SheetTitle>
          <SheetDescription>
            修改在 Git worktree 副本执行；验证后审阅并采纳。运行实例由你明确更新或重启。进程守卫不等于操作系统隔离。
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 p-4">
            <Button disabled={busy} onClick={() => void action('')}>
              创建隔离副本
            </Button>
            <Field>
              <FieldLabel htmlFor="framework-objective">修改目标</FieldLabel>
              <Textarea id="framework-objective" value={message} onChange={(event) => setMessage(event.target.value)} />
            </Field>
            {changes.map((change) => (
              <Card key={change.id}>
                <CardHeader>
                  <CardTitle>{change.state === 'adopted' ? '已采纳' : '隔离副本'}</CardTitle>
                  <CardDescription className="break-all">{change.workspace}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !message.trim() || change.state === 'adopted'}
                    onClick={() => onTask(change.id, message)}
                  >
                    在副本执行任务
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(`/${change.id}/review`)}>
                    查看差异
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || change.state === 'adopted'}
                    onClick={() => void action(`/${change.id}/validate`)}
                  >
                    运行验证
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !change.validation?.ok || change.state === 'adopted'}
                    onClick={() => setConfirm(change)}
                  >
                    采纳此修改
                  </Button>
                </CardContent>
              </Card>
            ))}
            {selected && (
              <>
                <h2 className="font-medium">审阅与验证</h2>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动差异区需要键盘聚焦才能滚动 */}
                <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {selected.review?.diff ?? '尚未生成差异'}
                </pre>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动验证区需要键盘聚焦才能滚动 */}
                <pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(selected.validation ?? '尚未验证', null, 2)}
                </pre>
              </>
            )}
            <AlertDialog
              open={!!confirm}
              onOpenChange={(open) => {
                if (!open) setConfirm(null);
              }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>采纳已审阅的框架修改？</AlertDialogTitle>
                  <AlertDialogDescription>
                    通过验证的文件将应用到原工作区。原工作区有冲突时停止应用。采纳后请明确更新或重启运行实例。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      if (confirm) void action(`/${confirm.id}/adopt`, { digest: confirm.review?.digest });
                    }}
                  >
                    采纳修改
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
