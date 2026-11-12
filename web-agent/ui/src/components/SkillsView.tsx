import { useEffect, useRef, useState } from 'react';
import { BookOpen, Download, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { evolveApi, skillsApi } from '../api';
import type { LockSkill, LockValidation, SkillInfo, SkillProposal, SkillUsageRow } from '../types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/ui/code-block';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

const SOURCE_LABEL: Record<SkillInfo['source'], string> = { builtin: '内置', pack: '技能包', user: '用户', project: '项目' };

export default function SkillsView() {
  const [installed, setInstalled] = useState<SkillInfo[]>([]);
  const [market, setMarket] = useState<{ name: string; description: string }[]>([]);
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [lock, setLock] = useState<LockSkill[]>([]);
  const [lockValidation, setLockValidation] = useState<LockValidation | null>(null);
  const [usage, setUsage] = useState<Record<string, SkillUsageRow>>({});
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; onOk: () => void } | null>(null);
  const guideRequest = useRef(0);
  const load = async () => {
    try {
      const [result, locked, used, evolved] = await Promise.all([
        skillsApi.list(), skillsApi.lock().catch(() => ({ file: null, count: 0, skills: [] as LockSkill[], validation: undefined })),
        skillsApi.usage().catch(() => ({ usage: {} as Record<string, SkillUsageRow> })),
        evolveApi.list().catch(() => ({ proposals: [] as SkillProposal[] })),
      ]);
      setInstalled(result.installed); setMarket(result.market); setLock(locked.skills ?? []); setLockValidation(locked.validation ?? null); setUsage(used.usage ?? {});
      setProposals((evolved.proposals ?? []).filter((proposal) => proposal.status === 'pending')); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try { await action(); await load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };
  const sync = () => run('sync', async () => {
    const result = await skillsApi.sync();
    const installedCount = result.results.filter((item) => item.installed).length;
    const failed = result.results.filter((item) => !item.ok);
    if (failed.length) toast.error(`同步完成 ${installedCount} 个，${failed.length} 个失败：${failed[0].error ?? ''}`);
    else toast.success(installedCount ? `已安装 ${installedCount} 个技能` : '锁文件中的技能均已安装');
  });
  const decide = (proposal: SkillProposal, action: 'accept' | 'reject') => run(proposal.id, async () => {
    const result = action === 'accept' ? await evolveApi.accept(proposal.id) : await evolveApi.reject(proposal.id);
    if (!result.ok) throw new Error(result.error ?? '操作失败');
    toast.success(action === 'accept' ? `已采纳为技能：${proposal.name}` : '已忽略该提案');
  });
  const uninstall = (skill: SkillInfo) => setConfirm({
    text: `卸载技能「${skill.name}」？它的说明文件会一起删掉。`,
    onOk: () => { void run(skill.name, async () => { await skillsApi.uninstall(skill.name); if (selected?.name === skill.name) { guideRequest.current++; setSelected(null); setGuide(null); } }); },
  });
  const readGuide = async (skill: SkillInfo) => {
    const requestId = ++guideRequest.current;
    setSelected(skill); setGuide(null); setGuideError(null);
    try { const result = await skillsApi.read(skill.name, skill.source); if (requestId === guideRequest.current) setGuide(result.content); }
    catch (err) { if (requestId === guideRequest.current) setGuideError(err instanceof Error ? err.message : String(err)); }
  };
  const keyword = query.trim().toLowerCase();
  const match = (item: { name: string; description?: string }) => !keyword || `${item.name} ${item.description ?? ''}`.toLowerCase().includes(keyword);
  const missing = lock.filter((skill) => !skill.installed);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] tracking-[0.06em] text-muted-foreground">扩展</p><h1>技能系统</h1><p>管理 Agent 可读取的指南、技能包和项目技能。</p></div><Badge variant="secondary">已安装 {installed.length}</Badge></header>
      <Input className="max-w-sm" aria-label="搜索技能" placeholder="搜索技能…" value={query} onChange={(event) => setQuery(event.target.value)} />
      {error && <Alert variant="destructive"><AlertTitle>技能加载失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {lockValidation && !lockValidation.ok && <Alert variant="destructive"><AlertTitle>技能锁文件校验失败</AlertTitle><AlertDescription>{lockValidation.errors.join('；')}</AlertDescription></Alert>}
      {loading && <div className="flex flex-col gap-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}
      {proposals.length > 0 && <section className="flex flex-col gap-3"><h2 className="text-sm font-medium">待确认的技能提案 · {proposals.length}</h2><ItemGroup>{proposals.map((proposal) => (
        <Item key={proposal.id} variant="outline"><ItemMedia variant="icon"><Sparkles /></ItemMedia><ItemContent className="min-w-0"><ItemTitle>{proposal.name}{(Array.isArray(proposal.signals) ? proposal.signals : []).map((signal) => <Badge key={signal} variant="secondary">{signal}</Badge>)}{proposal.seen > 1 && <Badge variant="outline">第 {proposal.seen} 次</Badge>}</ItemTitle><ItemDescription>{proposal.description}</ItemDescription><p className="text-xs text-muted-foreground">{proposal.reason}{proposal.question ? ` · 触发：${proposal.question.slice(0, 60)}` : ''}</p></ItemContent><ItemActions><Button size="sm" disabled={busy !== null} onClick={() => void decide(proposal, 'accept')}>{busy === proposal.id && <Spinner data-icon="inline-start" />}采纳</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void decide(proposal, 'reject')}>忽略</Button></ItemActions></Item>
      ))}</ItemGroup></section>}
      {lock.length > 0 && <section className="flex flex-col gap-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">锁文件 · 待安装 {missing.length}/{lock.length}</h2><Button variant="outline" size="sm" disabled={busy !== null || (lockValidation !== null && !lockValidation.ok)} onClick={() => void sync()}>{busy === 'sync' ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}同步安装</Button></div><ItemGroup>{missing.filter(match).slice(0, 12).map((skill) => <Item key={skill.name} variant="outline"><ItemMedia variant="icon"><Download /></ItemMedia><ItemContent className="min-w-0"><ItemTitle>{skill.name}<Badge variant="secondary">{skill.source}</Badge></ItemTitle><ItemDescription className="break-all">{skill.skillPath}{skill.version ? ` · v${skill.version}` : ''}{skill.computedHash ? ` · sha256 ${skill.computedHash.slice(0, 12)}…` : ''}</ItemDescription></ItemContent><Badge variant="outline">未安装</Badge></Item>)}</ItemGroup></section>}
      {(['builtin', 'project', 'pack', 'user'] as const).map((source) => {
        const skills = installed.filter((skill) => skill.source === source && match(skill));
        if (!skills.length) return null;
        return <section key={source} className="flex flex-col gap-3"><h2 className="text-sm font-medium">已安装 · {SOURCE_LABEL[source]} · {skills.length}</h2><ItemGroup>{skills.map((skill) => {
          const used = usage[skill.name];
          return <Item key={`${source}-${skill.name}`} variant="outline"><ItemMedia variant="icon"><BookOpen /></ItemMedia><ItemContent className="min-w-0"><ItemTitle><Button variant="link" className="h-auto justify-start p-0" onClick={() => void readGuide(skill)}>{skill.name}</Button><Badge variant="secondary">{SOURCE_LABEL[source]}</Badge>{skill.shadowed?.length ? <Badge variant="outline">覆盖 {skill.shadowed.join('/')}</Badge> : null}</ItemTitle><ItemDescription>{skill.description}</ItemDescription>{used && <p className="text-xs text-muted-foreground">索引 {used.indexShown} · 读取 {used.reads}{used.bodyTokens ? ` · ${used.bodyTokens.toLocaleString()} tok` : ''}</p>}</ItemContent>{source === 'user' && <ItemActions><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => uninstall(skill)}>卸载</Button></ItemActions>}</Item>;
        })}</ItemGroup></section>;
      })}
      {!loading && installed.filter(match).length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><BookOpen /></EmptyMedia><EmptyTitle>{keyword ? '没有匹配的技能' : '暂无已安装技能'}</EmptyTitle><EmptyDescription>{keyword ? `没有找到「${query.trim()}」，换个关键词试试。` : '从技能市场安装，或同步技能锁文件。'}</EmptyDescription></EmptyHeader></Empty>}
      {market.length > 0 && <section className="flex flex-col gap-3"><h2 className="text-sm font-medium">技能市场</h2><ItemGroup>{market.filter(match).map((skill) => <Item key={skill.name} variant="outline"><ItemMedia variant="icon"><Sparkles /></ItemMedia><ItemContent className="min-w-0"><ItemTitle>{skill.name}<Badge variant="secondary">市场</Badge></ItemTitle><ItemDescription>{skill.description}</ItemDescription></ItemContent><ItemActions><Button size="sm" disabled={busy !== null} onClick={() => void run(skill.name, async () => { await skillsApi.install(skill.name); toast.success(`已安装 ${skill.name}`); })}>{busy === skill.name && <Spinner data-icon="inline-start" />}安装</Button></ItemActions></Item>)}</ItemGroup></section>}
      <Sheet open={selected !== null} onOpenChange={(open) => { if (!open) { guideRequest.current++; setSelected(null); setGuide(null); } }}><SheetContent className="w-full sm:max-w-xl"><SheetHeader><SheetTitle>{selected?.name ?? '技能详情'}</SheetTitle><SheetDescription>{selected ? `${SOURCE_LABEL[selected.source]} · ${selected.description}` : '技能指南'}</SheetDescription></SheetHeader><ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-4 px-4 pb-6">{guideError ? <Alert variant="destructive"><AlertTitle>指南读取失败</AlertTitle><AlertDescription>{guideError}</AlertDescription></Alert> : guide === null ? <Skeleton className="h-40" /> : <CodeBlock><CodeBlockHeader><CodeBlockTitle>SKILL.md</CodeBlockTitle><CodeBlockActions><CodeBlockCopyButton value={guide} /></CodeBlockActions></CodeBlockHeader><CodeBlockContent wrap>{guide}</CodeBlockContent></CodeBlock>}<Button variant="outline" disabled={!selected} onClick={() => { if (selected) void readGuide(selected); }}><RefreshCw data-icon="inline-start" />重新读取指南</Button></div></ScrollArea></SheetContent></Sheet>
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
    </div>
  );
}
