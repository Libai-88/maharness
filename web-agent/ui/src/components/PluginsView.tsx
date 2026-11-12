import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { FolderOpen, Plug, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { pluginsApi } from '../api';
import type { PluginDiagnostic, PluginInfo } from '../types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

interface Props {
  plugins: PluginInfo[];
  diagnostics: PluginDiagnostic[];
  onAction: (id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall') => Promise<void> | void;
}

const isRunning = (plugin: PluginInfo) => plugin.state === 'started' || plugin.state === 'loaded';

function PluginExtras({ pluginId }: { pluginId: string }) {
  const [panel, setPanel] = useState<{ title: string; html: string } | null>(null);
  const [config, setConfig] = useState<{ config: Record<string, unknown>; schema?: Record<string, unknown> } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setPanel(null); setConfig(null); setLoading(true);
    void Promise.allSettled([
      fetch(`/api/plugins/${pluginId}/panel`).then((response) => response.ok ? response.json() : null),
      fetch(`/api/plugins/${pluginId}/config`).then((response) => response.ok ? response.json() : null),
    ]).then(([panelResult, configResult]) => {
      if (!alive) return;
      if (panelResult.status === 'fulfilled' && panelResult.value?.html) setPanel(panelResult.value);
      if (configResult.status === 'fulfilled' && configResult.value) setConfig(configResult.value);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [pluginId]);
  if (loading) return <Skeleton className="h-24" />;
  return <>
    {config && (Object.keys(config.config ?? {}).length > 0 || config.schema) && (
      <Card size="sm"><CardHeader><CardTitle>配置</CardTitle>{config.schema && <CardDescription>{Object.keys(config.schema).length} 个配置项</CardDescription>}</CardHeader><CardContent><CodeBlock size="sm"><CodeBlockContent wrap>{JSON.stringify(config.config ?? {}, null, 2)}</CodeBlockContent></CodeBlock></CardContent></Card>
    )}
    {panel && <Card size="sm"><CardHeader><CardTitle>{panel.title}</CardTitle></CardHeader><CardContent><div className="min-w-0 wrap-break-word" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(panel.html) }} /></CardContent></Card>}
  </>;
}

export default function PluginsView({ plugins, diagnostics, onAction }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; onOk: () => void } | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const selected = plugins.find((plugin) => plugin.id === selectedId) ?? null;
  const keyword = query.trim().toLowerCase();
  const filtered = plugins.filter((plugin) => !keyword || [plugin.name, plugin.id, plugin.error, ...(plugin.caps ?? [])].some((value) => value?.toLowerCase().includes(keyword)));
  const running = filtered.filter(isRunning);
  const stopped = filtered.filter((plugin) => !isRunning(plugin));
  const act = async (id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall') => {
    if (busy[id]) return;
    setBusy((current) => ({ ...current, [id]: true }));
    try { await onAction(id, action); if (action === 'uninstall') setSelectedId(null); }
    finally { setBusy((current) => ({ ...current, [id]: false })); }
  };
  const renderGroup = (title: string, items: PluginInfo[]) => (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2"><h2 className="text-sm font-medium">{title}</h2><Badge variant="secondary">{items.length}</Badge></div>
      <ItemGroup>
        {items.map((plugin) => (
          <Item key={plugin.id} variant="outline" className="plugin-card">
            <ItemMedia variant="icon"><Plug /></ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle><Button variant="link" className="h-auto justify-start p-0" onClick={() => setSelectedId(plugin.id)}>{plugin.name}</Button><Badge variant="outline">v{plugin.version}</Badge>{plugin.essential && <Badge variant="secondary">核心</Badge>}{plugin.execution?.mode === 'process' && <Badge variant="secondary">进程隔离</Badge>}{plugin.watched === false ? <Badge variant="secondary">内置</Badge> : isRunning(plugin) && <Badge variant="secondary">热重载</Badge>}</ItemTitle>
              <ItemDescription>{plugin.caps?.join(' · ') || '扩展插件'}</ItemDescription>
              {plugin.error && <p className="line-clamp-2 text-xs text-destructive">{plugin.error}</p>}
            </ItemContent>
            <ItemActions>
              <Badge variant={plugin.error ? 'destructive' : 'secondary'}>{isRunning(plugin) ? '运行中' : plugin.state === 'error' ? '出错' : '已停止'}</Badge>
              <Button variant="ghost" size="icon-sm" title="重新加载" aria-label={`重载插件 ${plugin.name}`} disabled={busy[plugin.id]} onClick={() => void act(plugin.id, 'reload')}>{busy[plugin.id] ? <Spinner /> : <RefreshCw />}</Button>
              <Switch checked={isRunning(plugin)} disabled={busy[plugin.id]} aria-label={`${isRunning(plugin) ? '停用' : '启用'}插件 ${plugin.name}`} onCheckedChange={(checked) => void act(plugin.id, checked ? 'enable' : 'disable')} />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-4 md:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] tracking-[0.06em] text-muted-foreground">扩展</p><h1>插件管理</h1><p>管理插件的运行状态、能力和配置。</p></div><Badge variant="secondary">{plugins.length} 个插件</Badge></header>
        <Input className="max-w-sm" aria-label="搜索插件" placeholder="搜索插件…" value={query} onChange={(event) => setQuery(event.target.value)} />
        {diagnostics.length > 0 && <Alert role="status"><AlertTitle>加载诊断</AlertTitle><AlertDescription>{diagnostics.map((diagnostic, index) => <p key={`${diagnostic.id}-${index}`}>{diagnostic.message}{diagnostic.suggestion && ` · ${diagnostic.suggestion}`}</p>)}</AlertDescription></Alert>}
        {running.length > 0 && renderGroup('运行中', running)}
        {stopped.length > 0 && renderGroup('已停止', stopped)}
        {filtered.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><Plug /></EmptyMedia><EmptyTitle>{keyword ? '没有匹配的插件' : '暂无插件'}</EmptyTitle><EmptyDescription>{keyword ? `没有找到「${query.trim()}」，换个关键词试试。` : '插件加载后会显示在这里。'}</EmptyDescription></EmptyHeader></Empty>}
        <Card><CardHeader><CardTitle>现场扩展</CardTitle><CardDescription>用户插件保存在 plugins/ 中，保存后自动重载。core/ 内置插件的改动需要重载或重启服务。</CardDescription></CardHeader><CardContent><CodeBlock size="sm"><CodeBlockContent wrap>{'plugins/clock/plugin.json\n{ "id": "clock", "name": "时钟工具", "version": "0.1.0", "entry": "index.ts", "enabled": true }'}</CodeBlockContent></CodeBlock></CardContent></Card>
      </div>
      <Sheet open={selected !== null} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <SheetContent className="w-full sm:max-w-lg">
          <SheetHeader><SheetTitle>{selected?.name ?? '插件详情'}</SheetTitle><SheetDescription>{selected ? `v${selected.version} · ${selected.id}` : '插件状态与配置'}</SheetDescription></SheetHeader>
          {selected && <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-4 px-4 pb-6">
            <div className="flex flex-wrap gap-2"><Badge variant={selected.error ? 'destructive' : 'secondary'}>{isRunning(selected) ? '运行中' : selected.state === 'error' ? '出错' : '已停止'}</Badge>{selected.execution?.mode === 'process' && <Badge variant="outline">子进程 · {selected.execution.memoryMb ?? 256}MB · {Math.round((selected.execution.timeoutMs ?? 30000) / 1000)}s</Badge>}{selected.circuitBreaker && selected.circuitBreaker.failures > 0 && <Badge variant="outline">连续失败 {selected.circuitBreaker.failures} 次</Badge>}</div>
            <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy[selected.id]} onClick={() => void act(selected.id, 'reload')}><RefreshCw data-icon="inline-start" />重载</Button><Button variant="outline" size="sm" onClick={() => { void pluginsApi.open(selected.id).catch((err) => toast.error(String(err))); }}><FolderOpen data-icon="inline-start" />打开目录</Button><Button variant="outline" size="sm" disabled={busy[selected.id]} onClick={() => void act(selected.id, isRunning(selected) ? 'disable' : 'enable')}>{isRunning(selected) ? '停用' : '启用'}</Button>{!selected.essential && <Button variant="destructive" size="sm" disabled={busy[selected.id]} onClick={() => setConfirm({ text: `卸载插件「${selected.name}」？插件目录会一起删掉，不可恢复。`, onOk: () => void act(selected.id, 'uninstall') })}>卸载</Button>}</div>
            {selected.error && <Alert variant="destructive"><AlertTitle>插件错误</AlertTitle><AlertDescription>{selected.error}{selected.circuitBreaker && selected.circuitBreaker.failures >= 3 && <p>已进入熔断态，系统将在 60 秒后自动重试。</p>}</AlertDescription></Alert>}
            {selected.fixSuggestion && <Alert><AlertTitle>修复建议</AlertTitle><AlertDescription>{selected.fixSuggestion}</AlertDescription></Alert>}
            <Card size="sm"><CardHeader><CardTitle>Manifest</CardTitle></CardHeader><CardContent><Table><TableBody>{[['id', selected.id], ['state', selected.state], ['caps', selected.caps?.join(', ') || '—'], ['enabled', String(isRunning(selected))]].map(([key, value]) => <TableRow key={key}><TableCell>{key}</TableCell><TableCell className="whitespace-normal break-all">{value}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
            <PluginExtras key={selected.id} pluginId={selected.id} />
          </div></ScrollArea>}
        </SheetContent>
      </Sheet>
      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>请确认</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">{confirm?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { confirm?.onOk(); setConfirm(null); }}>卸载</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}
