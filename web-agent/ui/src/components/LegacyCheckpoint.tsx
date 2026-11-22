import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';

interface LegacyRecord {
  exists: boolean;
  legacy?: boolean;
  turn: number;
  objective?: string;
  history?: unknown[];
}
export default function LegacyCheckpoint({
  sessionId,
  disabled,
  onSend,
}: {
  sessionId?: string;
  disabled: boolean;
  onSend: (message: string) => void;
}) {
  const [record, setRecord] = useState<LegacyRecord>();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let disposed = false;
    setRecord(undefined);
    setOpen(false);
    setConfirmed(false);
    setMessage('');
    if (sessionId)
      void api<LegacyRecord>(`/api/sessions/${sessionId}/checkpoint`)
        .then((value) => {
          if (!disposed) {
            setRecord(value);
            setMessage(value.objective ?? '');
          }
        })
        .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [sessionId]);
  if (!record?.exists || record.legacy === false) return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          查看历史断点
        </Button>
      </SheetTrigger>
      <SheetContent className="gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>历史断点</SheetTitle>
          <SheetDescription>
            旧运行记录保留至第 {record.turn + 1} 轮。核对已发生的文件和外部操作后，可用明确目标发起新任务。
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 p-4">
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动历史区需要键盘聚焦才能滚动 */}
            <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(record.history ?? [], null, 2)}
            </pre>
            <Field>
              <FieldLabel htmlFor="legacy-objective">续接目标</FieldLabel>
              <Textarea id="legacy-objective" value={message} onChange={(event) => setMessage(event.target.value)} />
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="legacy-effects" checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
              <FieldLabel htmlFor="legacy-effects">我已核对先前操作及其实际结果</FieldLabel>
            </Field>
            <Button
              disabled={disabled || !confirmed || !message.trim()}
              onClick={() => {
                onSend(message.trim());
                setOpen(false);
              }}
            >
              作为新任务继续
            </Button>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
