import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { personasApi } from '../api';
import type { PersonaInfo } from '../types';
import { Plus } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

export default function PersonaPanel() {
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [editing, setEditing] = useState<PersonaInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; onOk: () => void } | null>(null);

  const load = useCallback(async () => {
    try { setPersonas(await personasApi.list()); }
    catch (err) { toast.error(`人设没读到：${err instanceof Error ? err.message : String(err)}`); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const startCreate = () => { setCreating(true); setEditing(null); setName(''); setContent(''); };
  const startEdit = (p: PersonaInfo) => { setEditing(p); setCreating(false); setName(p.name); setContent(p.content); };
  const closeForm = () => { setCreating(false); setEditing(null); };

  const save = async () => {
    if (saving) return;
    if (!name.trim() || !content.trim()) { toast.error('名称与内容均为必填'); return; }
    setSaving(true);
    try {
      if (creating) { await personasApi.create({ name: name.trim(), content: content.trim() }); toast.success('人设已创建，下一轮对话即生效'); }
      else if (editing) { await personasApi.update(editing.id, { name: name.trim(), content: content.trim() }); toast.success('人设已保存（热生效）'); }
      closeForm();
      await load();
    } catch (err) {
      toast.error(`没保存上：${err instanceof Error ? err.message : String(err)}`);
    } finally { setSaving(false); }
  };

  const toggle = async (p: PersonaInfo) => {
    try { await personasApi.update(p.id, { enabled: !p.enabled }); await load(); }
    catch (err) { toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`); }
  };

  const remove = (p: PersonaInfo) => {
    setConfirm({
      text: `删除人设「${p.name}」？该人设的提示词会立即从系统提示词里撤下。`,
      onOk: async () => {
        try { await personasApi.remove(p.id); await load(); toast.success('已删除'); }
        catch (err) { toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`); }
      },
    });
  };

  const showForm = creating || editing;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3"><div><h1>人设与提示词</h1><p>人设按序叠加，即时生效；运行时规则固定，插件规则随插件调整。</p></div><Button onClick={startCreate}><Plus data-icon="inline-start" />新建人设</Button></header>
      {personas.map((persona) => <Card key={persona.id}><CardHeader><CardTitle>{persona.name}</CardTitle><CardDescription>{persona.enabled ? '启用中' : '已停用'}</CardDescription><CardAction><Switch checked={!!persona.enabled} aria-label={`${persona.enabled ? '停用' : '启用'}人设 ${persona.name}`} onCheckedChange={() => void toggle(persona)} /></CardAction></CardHeader><CardContent><p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{persona.content}</p></CardContent><CardFooter className="justify-end gap-2"><Button variant="outline" size="sm" onClick={() => startEdit(persona)}>编辑</Button><Button variant="destructive" size="sm" onClick={() => remove(persona)}>删除</Button></CardFooter></Card>)}
      {personas.length === 0 && <Empty><EmptyHeader><EmptyTitle>还没有人设</EmptyTitle><EmptyDescription>新建一个，定义 Agent 的身份与规则。</EmptyDescription></EmptyHeader></Empty>}
      <Dialog open={!!showForm} onOpenChange={(open) => { if (!open && !saving) closeForm(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{creating ? '新建人设' : `编辑 · ${editing?.name ?? ''}`}</DialogTitle><DialogDescription>身份、语气、能力边界与规则</DialogDescription></DialogHeader><form onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-col gap-5"><FieldGroup><Field><FieldLabel htmlFor="persona-name">名称</FieldLabel><Input id="persona-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="如：代码助手 / 写作助手" required /></Field><Field><FieldLabel htmlFor="persona-content">提示词内容</FieldLabel><Textarea id="persona-content" value={content} onChange={(event) => setContent(event.target.value)} placeholder={'身份：…\n语气：…\n能力边界：…\n规则：…'} rows={10} required /></Field></FieldGroup><DialogFooter><Button type="button" variant="outline" onClick={closeForm} disabled={saving}>取消</Button><Button type="submit" disabled={saving || !name.trim() || !content.trim()}>保存（热生效）</Button></DialogFooter></form></DialogContent></Dialog>
      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>请确认</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">{confirm?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { confirm?.onOk(); setConfirm(null); }}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
