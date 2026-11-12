import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ChevronsUpDown, FileText, Folder, FolderOpen, GitBranch, Maximize2, Plus, RefreshCw, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { fileApi, gitApi, workspacesApi, type GitStatus } from '../api';
import { useIsMobile } from '@/hooks/use-mobile';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/ui/code-block';
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from '@/components/ui/attachment';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface TreeEntry { name: string; type: 'dir' | 'file'; size: number }

function TreeNode({ entry, path, depth, selected, onOpen }: {
  entry: TreeEntry; path: string; depth: number; selected: string; onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rel = path === '.' ? entry.name : `${path}/${entry.name}`;
  const changeOpen = async (next: boolean) => {
    setOpen(next);
    if (next && children === null) {
      try { const result = await fileApi.tree(rel); setChildren(result.entries); setError(null); }
      catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    }
  };
  if (entry.type === 'file') {
    return (
      <Button variant={selected === rel ? 'secondary' : 'ghost'} size="sm" className="w-full justify-start" style={{ paddingLeft: depth * 14 + 24 }} aria-pressed={selected === rel} title={rel} onClick={() => onOpen(rel)}>
        <FileText data-icon="inline-start" /><span className="truncate">{entry.name}</span>
      </Button>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={(next) => void changeOpen(next)}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start" style={{ paddingLeft: depth * 14 + 8 }}>
          <ChevronRight data-icon="inline-start" className={open ? 'rotate-90' : undefined} /><Folder data-icon="inline-start" /><span className="truncate">{entry.name}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {error ? <p className="px-3 py-2 text-xs text-destructive">{error}</p> : children === null ? <Skeleton className="m-2 h-6" /> : children.length === 0 ? <p className="px-6 py-2 text-xs text-muted-foreground">空目录</p> : children.map((child) => <TreeNode key={child.name} entry={child} path={rel} depth={depth + 1} selected={selected} onOpen={onOpen} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function GitPanel({ onOpen }: { onOpen: (path: string) => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setStatus(await gitApi.status()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (action: 'commit' | 'push') => {
    if (busy || !status?.repo || (action === 'commit' && !message.trim())) return;
    setBusy(action);
    try {
      if (action === 'commit') { await gitApi.commit(message.trim()); setMessage(''); }
      else await gitApi.push();
      await load();
      toast.success(action === 'commit' ? '已提交' : '已推送');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };
  const changes = [...(status?.staged ?? []), ...(status?.changes ?? [])];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2 px-3">
        <GitBranch className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">{status?.repo ? status.branch || '(no branch)' : '非 Git 仓库'}</span>
        {status?.repo && <Badge variant="secondary">{changes.length}</Badge>}
        <Button variant="ghost" size="icon-sm" aria-label="刷新 Git 状态" onClick={() => void load()}><RefreshCw /></Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-2">
          {!status && !error && <Skeleton className="h-20" />}
          {status?.repo && changes.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><Check /></EmptyMedia><EmptyTitle>工作区干净</EmptyTitle></EmptyHeader></Empty>}
          {changes.map((change, index) => (
            <Button key={`${change.path}-${index}`} variant="ghost" size="sm" className="w-full justify-start" title={change.path} onClick={() => onOpen(change.path)}>
              <Badge variant={change.status === 'D' ? 'destructive' : 'outline'}>{change.status === '??' ? 'U' : change.status}</Badge>
              <span className="truncate">{change.path}</span>
            </Button>
          ))}
          {error && <Alert variant="destructive"><AlertTitle>Git 操作失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
      </ScrollArea>
      <form className="flex flex-col gap-3 px-3 pb-3" onSubmit={(event) => { event.preventDefault(); void act('commit'); }}>
        <FieldGroup><Field><FieldLabel htmlFor="commit-message">提交信息</FieldLabel><Input id="commit-message" placeholder={status?.repo ? '提交信息…' : '沙箱不是 Git 仓库'} value={message} onChange={(event) => setMessage(event.target.value)} disabled={!status?.repo || busy !== null} /></Field></FieldGroup>
        <p className="text-xs text-muted-foreground">Enter 提交全部变更（git add -A）</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" className="flex-1" disabled={!status?.repo || busy !== null || !status.ahead} onClick={() => void act('push')}>
            {busy === 'push' ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}推送{status?.ahead ? ` ${status.ahead}` : ''}
          </Button>
          <Button size="sm" className="flex-1" disabled={!status?.repo || busy !== null || !message.trim()}>{busy === 'commit' && <Spinner data-icon="inline-start" />}提交</Button>
        </div>
      </form>
    </div>
  );
}

export default function FilesView() {
  const [current, setCurrent] = useState('');
  const [workspaces, setWorkspaces] = useState<{ id: string; path: string }[]>([]);
  const [wsOpen, setWsOpen] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [roots, setRoots] = useState<TreeEntry[] | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<{ path: string; size: number }[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const fileRequest = useRef(0);
  const mobile = useIsMobile();
  const loadWorkspaces = useCallback(async () => {
    try { const items = await workspacesApi.list(); setWorkspaces(items); setCurrent(items.find((item) => item.current)?.path ?? items[0]?.path ?? ''); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  const loadRoot = useCallback(async () => {
    try { const result = await fileApi.tree('.'); setRoots(result.entries); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);
  useEffect(() => { if (current) { fileRequest.current++; setPreview(null); setEditing(false); setSearch(''); setResults(null); setRoots(null); void loadRoot(); } }, [current, loadRoot]);
  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing, fullscreen]);
  useEffect(() => {
    if (!search.trim()) { setResults(null); return; }
    let alive = true;
    const timer = setTimeout(() => { fileApi.search(search.trim()).then((result) => { if (alive) setResults(result.results); }).catch((err) => { if (alive) setError(String(err)); }); }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [search]);
  const openFile = async (path: string) => {
    const requestId = ++fileRequest.current;
    try {
      const result = await fileApi.read(path);
      if (fileRequest.current !== requestId) return;
      setPreview({ path, text: result.text }); setEditing(false); setExplorerOpen(false); setError(null);
    } catch (err) { if (fileRequest.current === requestId) setError(err instanceof Error ? err.message : String(err)); }
  };
  const save = async () => {
    if (!preview || !editing || saving) return;
    setSaving(true);
    try { await fileApi.write(preview.path, draft); setPreview({ path: preview.path, text: draft }); setEditing(false); toast.success(`已保存 ${preview.path}`); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  const closeFile = () => { fileRequest.current++; setPreview(null); setEditing(false); setFullscreen(false); };
  const explorer = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="px-3 pt-3">
        <Popover open={wsOpen} onOpenChange={setWsOpen}>
          <PopoverTrigger asChild><Button variant="outline" className="w-full justify-between" aria-label={`切换工作区，${current.split(/[\\/]/).pop() || '选择工作区'}`} title={current}><FolderOpen data-icon="inline-start" /><span className="truncate">{current.split(/[\\/]/).pop() || '选择工作区'}</span><ChevronsUpDown data-icon="inline-end" /></Button></PopoverTrigger>
          <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
            <Command><CommandList><CommandEmpty>暂无工作区</CommandEmpty><CommandGroup heading="工作区">
              {workspaces.map((workspace) => <CommandItem key={workspace.id} value={workspace.path} onSelect={() => { void workspacesApi.switchTo(workspace.path).then(loadWorkspaces).then(() => setWsOpen(false)).catch((err) => setError(String(err))); }}><Folder /><span className="min-w-0 flex-1 truncate" title={workspace.path}>{workspace.path}</span>{workspace.path === current && <Check />}</CommandItem>)}
            </CommandGroup></CommandList></Command>
            <Separator />
            <form className="flex items-end gap-2 p-3" onSubmit={(event) => { event.preventDefault(); if (newPath.trim()) void workspacesApi.add(newPath.trim()).then(loadWorkspaces).then(() => setNewPath('')).catch((err) => setError(String(err))); }}>
              <Field className="flex-1"><FieldLabel htmlFor="workspace-path">添加工作区</FieldLabel><Input id="workspace-path" value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="添加目录（绝对路径）…" /></Field>
              <Button size="icon" aria-label="添加工作区" disabled={!newPath.trim()}><Plus /></Button>
            </form>
          </PopoverContent>
        </Popover>
        <p className="mt-2 truncate text-xs text-muted-foreground" title={current}>{current}</p>
      </div>
      <Tabs defaultValue="files" className="min-h-0 flex-1 gap-3">
        <TabsList className="mx-3"><TabsTrigger value="files"><Folder />文件</TabsTrigger><TabsTrigger value="git"><GitBranch />Git</TabsTrigger></TabsList>
        <TabsContent value="files" className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-1 px-3"><Input aria-label="搜索文件" placeholder="搜索文件名…" value={search} onChange={(event) => setSearch(event.target.value)} /><Button variant="ghost" size="icon-sm" aria-label="刷新文件树" onClick={() => void loadRoot()}><RefreshCw /></Button></div>
          <ScrollArea className="min-h-0 flex-1"><div className="px-2 pb-3">
            {search.trim() ? results === null ? <Skeleton className="h-20" /> : results.length ? results.map((result) => <Button key={result.path} variant="ghost" size="sm" className="w-full justify-start" title={result.path} onClick={() => void openFile(result.path)}><FileText data-icon="inline-start" /><span className="truncate">{result.path}</span></Button>) : <Empty><EmptyHeader><EmptyTitle>无匹配文件</EmptyTitle></EmptyHeader></Empty> : roots === null ? <Skeleton className="h-28" /> : roots.length ? roots.map((entry) => <TreeNode key={`${current}-${entry.name}`} entry={entry} path="." depth={0} selected={preview?.path ?? ''} onOpen={(path) => void openFile(path)} />) : <Empty><EmptyHeader><EmptyTitle>空目录</EmptyTitle></EmptyHeader></Empty>}
          </div></ScrollArea>
        </TabsContent>
        <TabsContent value="git" className="flex min-h-0 flex-1"><GitPanel key={current} onOpen={(path) => void openFile(path)} /></TabsContent>
      </Tabs>
    </div>
  );
  const viewer = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b px-4 py-2">
        {mobile && <Sheet open={explorerOpen} onOpenChange={setExplorerOpen}><SheetTrigger asChild><Button variant="outline" size="icon-sm" aria-label="打开文件目录"><Folder /></Button></SheetTrigger><SheetContent side="left" className="w-80"><SheetHeader><SheetTitle>文件与 Git</SheetTitle><SheetDescription>工作区文件与版本控制</SheetDescription></SheetHeader>{explorer}</SheetContent></Sheet>}
        <Attachment size="xs" className="min-w-0 flex-1">
          <AttachmentMedia><FileText /></AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle title={preview?.path}>{preview?.path.split('/').pop() ?? '文件预览'}</AttachmentTitle>
            <AttachmentDescription title={preview?.path}>{preview?.path ?? '从左侧文件树选择文件'}</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
        {preview && <><Button variant="ghost" size="icon-sm" aria-label="在资源管理器中打开" onClick={() => { void fileApi.open(preview.path).catch((err) => toast.error(String(err))); }}><FolderOpen /></Button><Button variant="ghost" size="icon-sm" aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={() => setFullscreen(!fullscreen)}><Maximize2 /></Button><Button variant="ghost" size="icon-sm" aria-label="关闭文件" onClick={closeFile}><X /></Button>{editing ? <><Button size="sm" disabled={saving || draft === preview.text} onClick={() => void save()}>{saving && <Spinner data-icon="inline-start" />}保存</Button><Button variant="outline" size="sm" onClick={() => setEditing(false)}>取消</Button></> : <Button variant="outline" size="sm" onClick={() => { setDraft(preview.text); setEditing(true); }}>编辑</Button>}</>}
      </div>
      {preview ? editing ? <Textarea ref={editRef} aria-label={`编辑 ${preview.path}`} className="m-4 min-h-0 w-auto flex-1 resize-none font-mono" value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); } }} /> : <CodeBlock className="m-4 min-h-0 flex-1"><CodeBlockHeader><CodeBlockTitle>{preview.path.split('/').pop()}</CodeBlockTitle><CodeBlockActions><CodeBlockCopyButton value={preview.text} /></CodeBlockActions></CodeBlockHeader><CodeBlockContent lineNumbers className="min-h-0 flex-1">{preview.text}</CodeBlockContent></CodeBlock> : <Empty className="flex-1"><EmptyHeader><EmptyMedia variant="icon"><FileText /></EmptyMedia><EmptyTitle>选择文件查看内容</EmptyTitle><EmptyDescription>{mobile ? '打开文件目录，选择文件进行预览或编辑。' : '在左侧文件树中点击任意文件。'}</EmptyDescription></EmptyHeader></Empty>}
      <div className="flex flex-wrap items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground"><span>UTF-8</span>{preview && <><span>{preview.path.split('.').pop()?.toUpperCase()}</span><span>{(editing ? draft : preview.text).split('\n').length} 行</span>{editing && draft !== preview.text && <Badge variant="secondary">未保存</Badge>}</>}</div>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && <Alert variant="destructive" className="mx-4 mt-4 w-auto"><AlertTitle>文件操作失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex min-h-0 flex-1">
        {!mobile && <aside className="w-64 shrink-0 border-r">{explorer}</aside>}
        {fullscreen ? <Dialog open onOpenChange={setFullscreen}><DialogContent className="flex h-[90dvh] max-w-[94vw] flex-col sm:max-w-[94vw]" showCloseButton={false}><DialogHeader className="sr-only"><DialogTitle>{preview?.path ?? '文件预览'}</DialogTitle><DialogDescription>文件预览与编辑</DialogDescription></DialogHeader>{viewer}</DialogContent></Dialog> : viewer}
      </div>
    </div>
  );
}
