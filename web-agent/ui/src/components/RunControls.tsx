import { useState } from 'react';
import { toast } from 'sonner';
import { activeRun, runLabels, runsApi, type RunInfo } from '../run-api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldLabel } from '@/components/ui/field';

export default function RunControls({ run, onChanged, onResume, onNew }: { run: RunInfo; onChanged: () => void; onResume: () => void; onNew: (message: string) => Promise<void> }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const submit = async (replace: boolean) => {
    if (!message.trim()) return;
    setBusy(true);
    try {
      if (replace) await onNew(message.trim());
      else await runsApi.supplement(run.id, message.trim());
      setMessage(''); onChanged();
      if (!replace) toast.success('补充要求已保存，将在下一次模型调用前送达');
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <Alert className="mx-auto max-w-3xl" data-testid="run-controls">
    <AlertTitle>{runLabels[run.status]} · {run.model}</AlertTitle>
    <AlertDescription className="flex flex-col gap-2">
      <p>费用 ${run.cost.toFixed(4)}{run.usageStatus === 'estimated' ? '（估算）' : run.usageStatus === 'unknown' ? '（用量不完整）' : ''} · {run.verification ? '验收结果可在任务详情查看' : '结果尚未验证'}</p>
      {run.billingNotice && <p role="status">{run.billingNotice}</p>}
      {run.billingNotice && !activeRun(run) && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setBusy(true); void runsApi.acknowledgeBilling(run.id).then(onChanged).catch(error => toast.error(String(error))).finally(() => setBusy(false)); }}>已核对，本次无需处理</Button>}
      {run.error && <p>{run.error}</p>}
      {activeRun(run) && <Button size="sm" variant="outline" className="self-start" aria-expanded={expanded} aria-controls="run-message-editor" onClick={() => setExpanded(value => !value)}>补充或新建任务</Button>}
      {activeRun(run) && expanded && <div id="run-message-editor" className="flex flex-col gap-2">
        <Field><FieldLabel htmlFor="run-supplement">当前任务要求</FieldLabel><Textarea id="run-supplement" value={message} onChange={event => setMessage(event.target.value)} placeholder="补充目标或输入新任务" disabled={busy} /></Field>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" disabled={busy || !message.trim() || run.status === 'stopping'} onClick={() => void submit(false)}>补充当前任务</Button><Button size="sm" variant="outline" disabled={busy || !message.trim()} onClick={() => void submit(true)}>停止并发起新任务</Button></div>
      </div>}
      {run.status === 'interrupted' && !run.parentId && <Button size="sm" variant="secondary" disabled={busy} onClick={onResume}>恢复任务</Button>}
    </AlertDescription>
  </Alert>;
}
