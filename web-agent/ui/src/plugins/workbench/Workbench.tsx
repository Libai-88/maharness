import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { BriefcaseBusiness, CalendarCheck, CheckSquare, CircleHelp, Database, FolderKanban, Lightbulb, Moon, Plus, Search, Sun, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { day, live, removeRecords, type Kind } from '../../../../plugins/workbench/model';
import { WorkbenchStore } from './store';
import { Choice, WorkbenchContext, type Editor } from './shared';
import Tasks, { type Preferences } from './Tasks';
import { Focus, Notes, Projects } from './Views';
import { Backups, Review } from './Reports';
import RecordEditor from './RecordEditor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

const english = new URLSearchParams(location.search).get('lang') === 'en';
const L = (zh: string, en: string) => english ? en : zh;
const store = new WorkbenchStore(english);
const navigation = [
  { id: 'focus', title: L('今日聚焦', 'Today'), icon: CalendarCheck },
  { id: 'tasks', title: L('任务', 'Tasks'), icon: CheckSquare },
  { id: 'notes', title: L('灵感', 'Notes'), icon: Lightbulb },
  { id: 'projects', title: L('项目', 'Projects'), icon: FolderKanban },
  { id: 'review', title: L('复盘', 'Review'), icon: BriefcaseBusiness },
  { id: 'backup', title: L('数据与备份', 'Data and backups'), icon: Database },
];
function readPreferences(): Preferences {
  let saved: Partial<Preferences> = {}; try { saved = JSON.parse(localStorage.getItem('pd_wb_uipref') || '{}') || {}; } catch {}
  return { ...saved, taskView: ['list', 'board', 'matrix', 'timeline', 'month'].includes(String(saved.taskView)) ? saved.taskView! : 'list', boardGroup: ['prio', 'proj', 'tag'].includes(String(saved.boardGroup)) ? saved.boardGroup! : 'prio', taskSort: ['def', 'prio', 'due', 'new', 'title'].includes(String(saved.taskSort)) ? saved.taskSort! : 'def', navCollapsed: !!saved.navCollapsed, qaOpen: !!saved.qaOpen, nudgeHidden: !!saved.nudgeHidden, pomoMin: Number(saved.pomoMin) >= 1 && Number(saved.pomoMin) <= 180 ? Number(saved.pomoMin) : 25, pomoBreak: Number(saved.pomoBreak) >= 1 && Number(saved.pomoBreak) <= 60 ? Number(saved.pomoBreak) : 5 };
}
function Navigation({ view, navigate, search }: { view: string; navigate: (view: string) => void; search: () => void }) {
  const { setOpenMobile } = useSidebar(), { connection } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <Sidebar collapsible="icon">
    <SidebarHeader><SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" onClick={() => navigate('focus')} tooltip={L('办公工作台', 'Workbench')}><BriefcaseBusiness /><span className="font-medium">{L('办公工作台', 'Workbench')}</span></SidebarMenuButton></SidebarMenuItem><SidebarMenuItem><SidebarMenuButton onClick={search} tooltip={L('搜索', 'Search')}><Search /><span>{L('搜索', 'Search')}</span><Kbd className="ml-auto">⌘ K</Kbd></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarHeader>
    <SidebarContent><SidebarGroup><SidebarGroupContent><SidebarMenu>{navigation.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={view === item.id} onClick={() => { navigate(item.id); setOpenMobile(false); }} tooltip={item.title}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent>
    <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={() => { navigate('backup'); setOpenMobile(false); }} tooltip={connection.name || L('浏览器存储', 'Browser storage')}><Database /><span>{connection.active ? connection.name : L('存储未连接', 'Storage disconnected')}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter><SidebarRail />
  </Sidebar>;
}
interface Clock { end: number; phase: 'work' | 'break'; task: string }
export default function Workbench() {
  const { data: storedData, connection } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const data = { ...storedData, tasks: storedData.tasks.filter(task => task.lifecycle !== 'archived') };
  const [view, setView] = useState('focus'), [prefs, setPreferences] = useState(readPreferences);
  const [editor, setEditor] = useState<Editor | null>(null), [search, setSearch] = useState(false), [help, setHelp] = useState(false), [pomoOpen, setPomoOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; action: () => void } | null>(null);
  const [clock, setClockState] = useState<Clock | null>(null), clockRef = useRef<Clock | null>(null), [now, setNow] = useState(Date.now()), [pomoTask, setPomoTask] = useState('');
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const setPrefs = (patch: Partial<Preferences>) => setPreferences(current => { const next = { ...current, ...patch }; try { localStorage.setItem('pd_wb_uipref', JSON.stringify(next)); } catch (error) { toast.error(String(error)); } return next; });
  const setClock = (next: Clock | null) => { clockRef.current = next; setClockState(next); setNow(Date.now()); };
  const startPomo = (id: string) => { setPomoTask(id); if (!clockRef.current) setClock({ end: Date.now() + prefs.pomoMin * 60000, phase: 'work', task: id }); setPomoOpen(true); };
  const remove = (kind: Kind, ids: string[]) => { store.commit(draft => removeRecords(draft, kind, ids)); toast.success(L('已移至回收站', 'Moved to recycle bin'), { action: { label: L('撤销', 'Undo'), onClick: () => { store.undo(); } } }); };
  useEffect(() => { store.start().then(() => { const connection = store.getSnapshot().connection; if (connection.name && !connection.active) setView('backup'); }); }, []);
  useEffect(() => {
    const tick = window.setInterval(() => {
      const stamp = Date.now(), current = clockRef.current; setNow(stamp); if (!current || stamp < current.end) return;
      if (current.phase === 'work') {
        setClock({ end: stamp + prefsRef.current.pomoBreak * 60000, phase: 'break', task: current.task });
        store.commit(draft => { const task = draft.tasks.find(item => item.id === current.task); if (task) { task.pomo++; task.updatedAt = stamp; } draft.meta.pomoLog[day()] = (Number(draft.meta.pomoLog[day()]) || 0) + 1; }, false);
        toast.success(L('专注完成，休息一下。', 'Focus complete. Time for a break.'));
      } else { setClock(null); toast.success(L('休息结束', 'Break complete')); }
    }, 1000); return () => window.clearInterval(tick);
  }, []);
  const seconds = clock ? Math.max(0, Math.ceil((clock.end - now) / 1000)) : prefs.pomoMin * 60;
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  useEffect(() => { document.title = clock ? `${time} · ${L('办公工作台', 'Workbench')}` : L('办公工作台', 'Workbench'); }, [time, clock]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const editable = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearch(open => !open); return; }
      if (editable || document.querySelector('[role=dialog],[role=alertdialog]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); store.undo(); }
      else if (event.altKey && /^[1-6]$/.test(event.key)) { event.preventDefault(); setView(navigation[Number(event.key) - 1].id); }
      else if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') { event.preventDefault(); setEditor({ kind: 'task' }); }
      else if (event.key === '?') { event.preventDefault(); setHelp(true); }
    }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  const edit = (next: Editor) => { setSearch(false); setEditor(next); };
  const page = navigation.find(item => item.id === view)!;
  return <WorkbenchContext.Provider value={{ data, store, L, english, edit, remove, startPomo, confirm: (title, action, description = L('请确认此操作。', 'Please confirm this action.')) => setConfirmation({ title, description, action }) }}>
    <TooltipProvider><SidebarProvider open={!prefs.navCollapsed} onOpenChange={open => setPrefs({ navCollapsed: !open })} style={{ '--sidebar-width': '13rem' } as CSSProperties} className="h-dvh min-h-0 overflow-hidden">
      <Navigation view={view} navigate={setView} search={() => setSearch(true)} />
      <SidebarInset className="h-dvh min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4"><SidebarTrigger aria-label={L('切换导航', 'Toggle navigation')} /><h1 className="min-w-0 flex-1 truncate text-sm font-medium">{page.title}</h1><Button variant="ghost" size="sm" onClick={() => setPomoOpen(true)}>{clock ? time : L('专注', 'Focus')}<span className="sr-only">{L('番茄钟', 'Pomodoro timer')}</span></Button><Button variant="ghost" size="icon-sm" aria-label={L('撤销', 'Undo')} onClick={() => store.undo()}><Undo2 /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={L('切换主题', 'Toggle theme')} onClick={() => { const dark = !document.documentElement.classList.contains('dark'); localStorage.setItem('maharness-theme', dark ? 'dark' : 'light'); document.documentElement.classList.toggle('dark', dark); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }}>{document.documentElement.classList.contains('dark') ? <Sun /> : <Moon />}</Button>
          <Button variant="ghost" size="sm" onClick={() => { const url = new URL(location.href); url.searchParams.set('lang', english ? 'zh' : 'en'); location.assign(url); }}>{english ? '中' : 'EN'}<span className="sr-only">{L('切换到中文', 'Switch to English')}</span></Button>
          <Button variant="ghost" size="icon-sm" aria-label={L('快捷键', 'Keyboard shortcuts')} onClick={() => setHelp(true)}><CircleHelp /></Button>
        </header>
        <ScrollArea className="min-h-0 flex-1"><main className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-6 p-4 md:p-6" data-testid="workbench-view">
          <div className="flex items-center justify-between gap-3"><div className="flex flex-col gap-1"><h2 className="text-2xl font-semibold tracking-tight">{page.title}</h2><p className="text-sm text-muted-foreground">{new Date().toLocaleDateString(english ? 'en-US' : 'zh-CN', { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>{data.meta.sample && <Badge variant="outline" aria-hidden>{L('示例数据', 'Sample data')}</Badge>}</div>
          {connection.error && view !== 'backup' && <Alert variant="destructive"><AlertTitle>{L('存储需要处理', 'Storage needs attention')}</AlertTitle><AlertDescription>{connection.error}<Button variant="outline" size="sm" onClick={() => setView('backup')}>{L('数据与备份', 'Data and backups')}</Button></AlertDescription></Alert>}
          {view === 'focus' ? <Focus prefs={prefs} setPrefs={setPrefs} /> : view === 'tasks' ? <Tasks prefs={prefs} setPrefs={setPrefs} /> : view === 'notes' ? <Notes /> : view === 'projects' ? <Projects /> : view === 'review' ? <Review /> : <Backups />}
        </main></ScrollArea>
      </SidebarInset>
    </SidebarProvider></TooltipProvider>
    {editor && <RecordEditor key={`${editor.kind}:${editor.id || 'new'}`} editor={editor} close={() => setEditor(null)} />}
    <CommandDialog open={search} onOpenChange={setSearch} title={L('搜索工作台', 'Search workbench')} description={L('搜索任务、项目或灵感', 'Find tasks, projects or notes')}><Command><CommandInput placeholder={L('搜索任务、项目或灵感…', 'Search tasks, projects or notes…')} /><CommandList><CommandEmpty>{L('没有匹配结果', 'No results found')}</CommandEmpty><CommandGroup heading={L('操作', 'Actions')}><CommandItem onSelect={() => edit({ kind: 'task' })}><Plus />{L('新建任务', 'New task')}</CommandItem></CommandGroup>
      <CommandGroup heading={L('任务', 'Tasks')}>{data.tasks.map(task => <CommandItem key={task.id} value={task.title} onSelect={() => edit({ kind: 'task', id: task.id })}><CheckSquare /><span className="truncate">{task.title}</span></CommandItem>)}</CommandGroup>
      <CommandGroup heading={L('项目', 'Projects')}>{data.projects.map(project => <CommandItem key={project.id} value={project.name} onSelect={() => edit({ kind: 'proj', id: project.id })}><FolderKanban /><span className="truncate">{project.name}</span></CommandItem>)}</CommandGroup>
      <CommandGroup heading={L('灵感', 'Notes')}>{data.notes.map(note => <CommandItem key={note.id} value={note.text} onSelect={() => edit({ kind: 'note', id: note.id })}><Lightbulb /><span className="truncate">{note.text}</span></CommandItem>)}</CommandGroup>
    </CommandList></Command></CommandDialog>
    <Dialog open={pomoOpen} onOpenChange={setPomoOpen}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>{L('番茄钟', 'Pomodoro timer')}</DialogTitle><DialogDescription>{clock?.phase === 'break' ? L('休息时间', 'Break time') : L('一次专注一件事', 'Focus on one thing at a time')}</DialogDescription></DialogHeader><p className="py-4 text-center text-5xl font-medium tabular-nums" role="timer" aria-label={L('剩余时间', 'Time remaining')}>{time}</p><FieldGroup><Field><FieldLabel>{L('专注任务', 'Focus task')}</FieldLabel><Choice label={L('专注任务', 'Focus task')} value={clock?.task || pomoTask} disabled={!!clock} onChange={setPomoTask} options={[["", L('自由专注', 'Free focus')], ...data.tasks.filter(live).map(task => [task.id, task.title] as [string, string])]} /></Field><FieldGroup className="grid grid-cols-2 gap-4"><Field><FieldLabel htmlFor="pomo-work">{L('专注（分钟）', 'Work (minutes)')}</FieldLabel><Input id="pomo-work" type="number" min={1} max={180} value={prefs.pomoMin} disabled={!!clock} onChange={event => setPrefs({ pomoMin: Math.max(1, Math.min(180, Number(event.target.value) || 25)) })} /></Field><Field><FieldLabel htmlFor="pomo-break">{L('休息（分钟）', 'Break (minutes)')}</FieldLabel><Input id="pomo-break" type="number" min={1} max={60} value={prefs.pomoBreak} disabled={!!clock} onChange={event => setPrefs({ pomoBreak: Math.max(1, Math.min(60, Number(event.target.value) || 5)) })} /></Field></FieldGroup></FieldGroup><Button onClick={() => clock ? setClock(null) : startPomo(pomoTask)}>{clock ? L('停止', 'Stop') : L('开始专注', 'Start focus')}</Button></DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent><DialogHeader><DialogTitle>{L('快捷键', 'Keyboard shortcuts')}</DialogTitle><DialogDescription>{L('更快地切换与记录', 'Navigate and capture quickly')}</DialogDescription></DialogHeader><dl className="flex flex-col gap-4">{[['Ctrl / ⌘ K', L('搜索', 'Search')], ['Alt 1–6', L('切换页面', 'Switch page')], ['N', L('新建任务', 'New task')], ['Ctrl / ⌘ Z', L('撤销', 'Undo')], ['?', L('帮助', 'Help')]].map(([key, action]) => <div key={key} className="flex items-center justify-between"><dt><Kbd>{key}</Kbd></dt><dd className="text-sm">{action}</dd></div>)}</dl></DialogContent></Dialog>
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmation?.title}</AlertDialogTitle><AlertDialogDescription>{confirmation?.description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{L('取消', 'Cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => confirmation?.action()}>{L('确认', 'Confirm')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </WorkbenchContext.Provider>;
}
