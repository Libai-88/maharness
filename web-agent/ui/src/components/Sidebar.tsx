import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  BriefcaseBusiness,
  CalendarClock,
  Folder,
  ListChecks,
  MessageCircle,
  MoreHorizontal,
  Pin,
  Plus,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import BrandMark from '@/brand/BrandMark';
import type { Session } from '../types';
import { AGENT_NAME, APP_VERSION, chatTime, displayTitle, previewOf } from '../voice';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
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

export type MainTab = string;

export interface TabDef {
  key: string;
  label: string;
  icon: React.ReactNode;
}

export const BUILTIN_TABS: TabDef[] = [
  { key: 'chat', label: '会话', icon: <MessageCircle /> },
  { key: 'files', label: '文件', icon: <Folder /> },
  { key: 'workbench', label: '工作台', icon: <BriefcaseBusiness /> },
  { key: 'society', label: 'AI 社会', icon: <ListChecks /> },
  { key: 'automations', label: '自动化', icon: <CalendarClock /> },
];

interface Props {
  sessions: Session[];
  activeId: string | null;
  activeTab: MainTab;
  onTab: (t: MainTab) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => void;
  onBatchDelete: (ids: string[]) => void;
  onBatchArchive: (ids: string[]) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  pluginRunning: number;
  streamingId?: string | null;
  version?: string;
}

const READS_KEY = 'maharness-reads';

function loadReads(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(READS_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export default memo(function Sidebar({
  sessions,
  activeId,
  activeTab,
  onTab,
  onSelect,
  onCreate,
  onDelete,
  onArchive,
  onPin,
  onRename,
  onBatchDelete,
  onBatchArchive,
  settingsOpen,
  onToggleSettings,
  pluginRunning,
  streamingId,
  version,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reads, setReads] = useState<Record<string, number>>(loadReads);
  const [confirm, setConfirm] = useState<{ text: string; okText?: string; danger?: boolean; onOk: () => void } | null>(null);
  const renameCommitted = useRef(false);
  const { setOpenMobile } = useSidebar();

  const markRead = useCallback((id: string | null) => {
    if (!id) return;
    setReads((prev) => {
      const next = { ...prev, [id]: Date.now() };
      try {
        localStorage.setItem(READS_KEY, JSON.stringify(next));
      } catch {
        // localStorage may be unavailable in privacy mode.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    markRead(activeId);
  }, [activeId, markRead]);

  const pinned = sessions.filter((s) => s.pinned && !s.archived);
  const normal = sessions.filter((s) => !s.pinned && !s.archived);
  const archived = sessions.filter((s) => s.archived);
  const allIds = sessions.map((s) => s.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const commitRename = () => {
    if (renameCommitted.current) return;
    renameCommitted.current = true;
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allIds));
  const exitManage = () => {
    setManaging(false);
    setSelected(new Set());
  };

  const doBatchDelete = () => {
    if (!selected.size) return;
    const n = selected.size;
    setConfirm({
      text: `删掉这 ${n} 段对话？删了就找不回来了。`,
      okText: '删除',
      danger: true,
      onOk: () => {
        onBatchDelete([...selected]);
        exitManage();
      },
    });
  };

  const doBatchArchive = () => {
    if (!selected.size) return;
    const n = selected.size;
    setConfirm({
      text: `把这 ${n} 段对话收进归档？之后随时能翻出来。`,
      okText: '归档',
      onOk: () => {
        onBatchArchive([...selected]);
        exitManage();
      },
    });
  };

  const askDelete = (s: Session) =>
    setConfirm({
      text: `删掉「${displayTitle(s.title)}」这段对话？删了就找不回来了。`,
      okText: '删除',
      danger: true,
      onOk: () => onDelete(s.id),
    });

  const renderItem = (s: Session) => {
    const modeText = s.mode === 'plan' ? '计划模式' : s.mode === 'goal' ? '目标模式' : '';
    const preview = previewOf(s.lastRole, s.lastMsg);
    const typing = streamingId === s.id;
    const unread = s.id !== activeId && !managing && s.lastRole === 'assistant' && s.updatedAt > (reads[s.id] ?? 0);
    const active = s.id === activeId;

    if (editingId === s.id) {
      return (
        <SidebarMenuItem key={s.id}>
          <div className="flex min-h-14 items-center gap-2.5 rounded-md px-2 py-2">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground"
              aria-hidden
            >
              <BrandMark size={18} />
            </span>
            <Input
              className="min-w-0 flex-1"
              aria-label="重命名会话"
              value={draft}
              autoFocus
              onFocus={() => {
                renameCommitted.current = false;
              }}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === 'Escape') {
                  renameCommitted.current = true;
                  setEditingId(null);
                }
                event.stopPropagation();
              }}
              onBlur={commitRename}
            />
          </div>
        </SidebarMenuItem>
      );
    }

    return (
      <SidebarMenuItem key={s.id}>
        {managing && (
          <Checkbox
            checked={selected.has(s.id)}
            onCheckedChange={() => toggleSelect(s.id)}
            aria-label={`选择会话 ${displayTitle(s.title)}`}
            className="absolute top-4 left-2"
          />
        )}
        <SidebarMenuButton
          isActive={managing ? selected.has(s.id) : active}
          size="lg"
          className={cn('h-auto min-h-14 items-start gap-2.5 py-2 pr-8', managing && 'pl-9')}
          onClick={() => {
            if (managing) toggleSelect(s.id);
            else {
              markRead(s.id);
              onSelect(s.id);
              setOpenMobile(false);
            }
          }}
          onDoubleClick={() => {
            if (!managing) {
              setEditingId(s.id);
              setDraft(s.title || '');
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'F2' && !managing) {
              event.preventDefault();
              setEditingId(s.id);
              setDraft(s.title || '');
            }
          }}
          title={s.title || '新会话'}
          aria-current={active ? 'page' : undefined}
        >
          {!managing && (
            <span
              className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground"
              aria-hidden
            >
              <BrandMark size={18} />
              {unread && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-2 border-sidebar bg-primary" />}
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.01em]">{displayTitle(s.title)}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{chatTime(s.updatedAt)}</span>
            </span>
            <span className="min-h-4 truncate text-[11px] leading-4 text-foreground/70">
              {typing ? (
                <span className="text-sidebar-foreground">{AGENT_NAME}正在输入…</span>
              ) : preview ? (
                <span className={cn(s.lastRole === 'user' && 'text-foreground/65')}>{preview}</span>
              ) : s.role ? (
                <span>{s.role} 接手了</span>
              ) : modeText ? (
                <span>{modeText}</span>
              ) : (
                <span>还没聊过，打个招呼吧</span>
              )}
            </span>
          </span>
        </SidebarMenuButton>

        {!managing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuAction showOnHover aria-label={`管理会话 ${displayTitle(s.title)}`}>
                <MoreHorizontal />
              </SidebarMenuAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => onPin(s.id, !s.pinned)}>
                  <Pin />
                  {s.pinned ? '取消置顶' : '置顶'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onArchive(s.id, !s.archived)}>
                  <Archive />
                  {s.archived ? '移出归档' : '归档'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => askDelete(s)}>
                  <Trash2 />
                  删除
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </SidebarMenuItem>
    );
  };

  return (
    <SidebarRoot collapsible="offcanvas" className="border-r border-sidebar-border">
      <SidebarHeader className="h-16 flex-row items-center gap-2.5 px-3">
        <div className="flex size-9 items-center justify-center overflow-hidden rounded-xl bg-[#fff8ed] shadow-sm ring-1 ring-black/5">
          <BrandMark size={30} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-[-0.02em]">maharness</div>
          <div className="text-[11px] text-muted-foreground">Agent workspace</div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作区</SidebarGroupLabel>
          <SidebarMenu>
            {BUILTIN_TABS.map((tab) => (
              <SidebarMenuItem key={tab.key}>
                <SidebarMenuButton
                  isActive={activeTab === tab.key && !settingsOpen}
                  tooltip={tab.label}
                  onClick={() => {
                    onTab(tab.key);
                    setOpenMobile(false);
                  }}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>对话</SidebarGroupLabel>
          <div className="flex gap-2 px-2 pb-2">
            <Button
              className="flex-1 justify-start"
              disabled={managing}
              onClick={() => {
                onCreate();
                setOpenMobile(false);
              }}
            >
              <Plus data-icon="inline-start" />
              新会话
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                if (managing) exitManage();
                else setManaging(true);
              }}
              title={managing ? '退出批量管理' : '批量管理会话'}
              aria-label={managing ? '退出批量管理' : '批量管理会话'}
            >
              {managing ? <X /> : <ListChecks />}
            </Button>
          </div>

          {managing && (
            <div className="mx-2 mb-1.5 flex items-center justify-between rounded-lg bg-sidebar-accent px-2.5 py-1.5 text-[11px]">
              <span className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  aria-label="全选会话"
                  checked={allSelected ? true : selected.size ? 'indeterminate' : false}
                  onCheckedChange={toggleAll}
                />
                全选
              </span>
              <span className="text-muted-foreground">{selected.size} 已选</span>
            </div>
          )}

          {sessions.length === 0 && (
            <Empty className="px-3 py-8">
              <EmptyHeader>
                <EmptyTitle>还没有对话</EmptyTitle>
                <EmptyDescription>点击「新会话」开始。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </SidebarGroup>

        {pinned.length > 0 && (
          <SidebarGroup className="py-0">
            <SidebarGroupLabel>置顶</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{pinned.map(renderItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {normal.length > 0 && (
          <SidebarGroup className="py-0">
            <SidebarGroupLabel>最近</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{normal.map(renderItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {archived.length > 0 && (
          <SidebarGroup className="py-0">
            <SidebarGroupLabel>归档</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{archived.map(renderItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        {managing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={doBatchArchive} disabled={!selected.size}>
              <Archive data-icon="inline-start" />
              归档
            </Button>
            <Button variant="destructive" size="sm" className="flex-1" onClick={doBatchDelete} disabled={!selected.size}>
              <Trash2 data-icon="inline-start" />
              删除
            </Button>
            <Button size="sm" onClick={exitManage}>
              完成
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between px-0.5">
              <Badge variant="secondary" className="h-5 rounded-md px-1.5 text-[10px] font-medium text-muted-foreground">
                {pluginRunning} 个插件运行中
              </Badge>
              <span className="font-mono text-[10px] text-muted-foreground">v{version ?? APP_VERSION}</span>
            </div>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={settingsOpen}
                  onClick={() => {
                    onToggleSettings();
                    setOpenMobile(false);
                  }}
                >
                  <Settings />
                  设置
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </>
        )}
      </SidebarFooter>
      <AlertDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>请确认</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">{confirm?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.danger ? 'destructive' : 'default'}
              onClick={() => {
                confirm?.onOk();
                setConfirm(null);
              }}
            >
              {confirm?.okText ?? '好'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SidebarRail />
    </SidebarRoot>
  );
});
