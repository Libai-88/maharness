// ui/src/components/StatsView.tsx —— 统计视图（Screen 3）：三层缓存 + 全局概览（真实 statsApi）
import { useEffect, useState } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { statsApi } from '../api';
import { fadeUp, staggerContainer } from '../motion';
import { money } from '../voice';
import type { StatsInfo } from '../types';

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
// F2：成本统一走 voice.money（全站单一口径 $）——定价按 USD/1M 计，此前本文件用 ¥ 是错的。
const cost = (n: number) => money(n);

/** 百分比格式化：后端 rate 已是 0-100 数值（42.5 = 42.5%），不再乘 100 */
function pct(n: number) { return `${n.toFixed(1)}%`; }

/** 数字 count-up（motion）：值变化时从 0 平滑滚动到目标值（Linear/Vercel 式 KPI 动效） */
function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.7, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [value]);
  return <motion.span>{text}</motion.span>;
}

export default function StatsView() {
  const [stats, setStats] = useState<StatsInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const s = await statsApi.get(); if (alive) { setStats(s); setErr(null); } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (err) return <div className="view-scroll"><div className="empty-state">统计加载失败：{err}</div></div>;
  if (!stats) return <div className="view-scroll"><div className="empty-state">统计加载中…</div></div>;

  const { overview, process, cache, context } = stats;
  const q = context?.quality ?? { injections: 0, compactions: 0, truncations: 0, modelRoutes: 0, reasoningHints: 0, toolDefinitions: 0, toolDefBytes: 0 };
  const overall = cache.overall;
  const l1 = cache.l1 ?? { hits: 0, misses: 0, rate: 0 };
  const l2 = cache.l2 ?? { hits: 0, misses: 0, rate: 0 };
  const l3 = cache.l3 ?? { hits: 0, tokens: 0 };

  return (
    <div className="view-scroll">
      <motion.div variants={staggerContainer} initial="initial" animate="enter">
      <motion.div variants={fadeUp} className="page-head">
        <div className="ph-eyebrow">
          <span className="ph-no">03</span>
          <span className="ph-label">CACHE & COST</span>
          <span className="ph-rule" />
          <span className="ph-cn">缓存与成本</span>
        </div>
        <span className="ph-title">看得见的成本，看得见的缓存</span>
        <span className="ph-sub">三层缓存命中即可见 · 累计节省 {cost(cache.savedCost ?? 0)}</span>
      </motion.div>

      <motion.div variants={fadeUp} className="stats-row">
        <div className="hero-card">
          <div className="hero-head">
            <span className="hero-label">综合命中率 · HIT RATE</span>
            <span className="hero-badge">{cache.l3.realHits > 0 ? 'L3 真实命中' : cache.l1Enabled ? 'L1 已启用' : 'L1 关闭'}</span>
          </div>
          <div className="hero-value"><AnimatedNumber value={cache.l3.realHits > 0 ? cache.l3.realRate : (overall?.rate ?? 0)} format={pct} /></div>
          <div className="hero-sub">
            {cache.l3.realHits > 0
              ? `provider 确认命中 ${fmt(cache.l3.realTokens)} tok · 折合 ${cost(cache.savedCost ?? 0)}`
              : `节省调用 ${overall?.served ?? 0} 次 · 折合 ${cost(cache.savedCost ?? 0)}`}
          </div>
          {/* F2 修复：此前这里是硬编码的 [36,44,28,52,48,60,64] 假柱状图配 Mon/Wed/Sun
              三个标签（7 柱 3 标不对位、且不反映任何真实数据）——与「诚实呈现：真实状态、
              真实数据」的信条直接冲突。改为**三层缓存命中率的真实对比**：数据全部来自
              /api/stats。L3 无 provider 真实反馈时不画估算百分比（估算口径没有可靠分母，
              画出来就是假数据），显示 L1/L2 两层的真实命中率。 */}
          <div className="hero-chart" role="img" aria-label={`命中率：L1 ${pct(l1.rate ?? 0)}，L2 ${pct(l2.rate ?? 0)}${cache.l3.realHits > 0 ? `，L3 ${pct(cache.l3.realRate)}` : ''}`}>
            <div className="hc-bars hc-bars-real">
              {[
                { k: 'L1', v: l1.rate ?? 0, color: 'var(--purple)' },
                { k: 'L2', v: l2.rate ?? 0, color: 'var(--teal)' },
                ...(cache.l3.realHits > 0 ? [{ k: 'L3', v: cache.l3.realRate, color: 'var(--accent)' }] : []),
              ].map((b) => (
                <div key={b.k} className="hc-bar-wrap">
                  <div className="hc-bar-real" style={{ height: `${Math.max(2, Math.min(100, b.v))}%`, background: b.color }} />
                  <span className="hc-bar-val">{pct(b.v)}</span>
                </div>
              ))}
              {cache.l3.realHits === 0 && (
                <div className="hc-bar-wrap">
                  <div className="hc-bar-real hc-bar-na" />
                  <span className="hc-bar-val">L3 —</span>
                </div>
              )}
            </div>
            <div className="hc-labels"><span>L1 语义</span><span>L2 工具</span><span>L3 前缀</span></div>
          </div>
        </div>
        <div className="saved-card">
          {/* C3 修复：served 是 L1+L2+L3 的**历史累计**计数，此前文案写「本周节省调用」
              等于给同一个数字挂了两个时间窗（别处称"历史累计"）。改为如实标注。 */}
          <span className="sc-label">累计节省调用</span>
          <span className="sc-value"><AnimatedNumber value={overall?.served ?? 0} format={fmt} /></span>
          <span className="sc-sub">次 · LLM call skipped（历史累计）</span>
          <div className="sc-divider" />
          <div className="sc-row">
            <div className="sc-row-left"><span className="sc-dot" style={{ background: 'var(--purple)' }} /><span className="sc-lbl">L1 语义缓存</span></div>
            <span className="sc-val"><AnimatedNumber value={l1.hits} format={fmt} /></span>
          </div>
          <div className="sc-row">
            <div className="sc-row-left"><span className="sc-dot" style={{ background: 'var(--teal)' }} /><span className="sc-lbl">L2 工具结果</span></div>
            <span className="sc-val"><AnimatedNumber value={l2.hits} format={fmt} /></span>
          </div>
          <div className="sc-row">
            <div className="sc-row-left"><span className="sc-dot" style={{ background: 'var(--accent)' }} /><span className="sc-lbl">L3 prompt 前缀</span></div>
            <span className="sc-val"><AnimatedNumber value={l3.hits} format={fmt} /></span>
          </div>
        </div>
      </motion.div>

      <motion.div variants={fadeUp} className="cache-cards">
        <div className="cache-card c1">
          <div className="cc-head">
            <span className="cc-badge b1">L1 语义问答</span>
            <span className="cc-rate"><AnimatedNumber value={l1.rate ?? 0} format={pct} /></span>
          </div>
          <span className="cc-desc">字符 bigram · Dice 相似度</span>
          <span className="cc-meta">命中 {l1.hits} · 完全跳过 LLM{cache.l1Enabled ? '' : ' · 已关闭'}</span>
          {/* F2：cc-bar-fill 此前无宽度绑定（静态假进度条）——按真实命中率给宽度 */}
          <div className="cc-bar"><div className="cc-bar-fill" style={{ width: `${Math.max(0, Math.min(100, l1.rate ?? 0))}%` }} /></div>
          {/* E1：阈值来自后端真实生效值（此前硬编码 0.85，而 0.85 恰是缓存体系设计文档
              实测否决的值；生效值一直是 0.58）。缺字段时退回 0.58，不再退回 0.85。 */}
          <span className="cc-example">阈值 ≥ {(cache.l1Threshold ?? 0.58).toFixed(2)} 触发命中 · 免 embedding API</span>
        </div>
        <div className="cache-card c2">
          <div className="cc-head">
            <span className="cc-badge b2">L2 工具结果</span>
            <span className="cc-rate"><AnimatedNumber value={l2.rate ?? 0} format={pct} /></span>
          </div>
          <span className="cc-desc">hash(工具+参数) + mtime/size</span>
          <span className="cc-meta">命中 {l2.hits} · TTL {cache.l2TtlMin ?? 30} min · 重复调用不重算</span>
          <div className="cc-bar"><div className="cc-bar-fill" style={{ width: `${Math.max(0, Math.min(100, l2.rate ?? 0))}%` }} /></div>
          <span className="cc-example">适用 read_file / list_dir / glob</span>
        </div>
        <div className="cache-card c3">
          <div className="cc-head">
            <span className="cc-badge b3">L3 prompt 前缀</span>
            <span className="cc-rate"><AnimatedNumber value={cache.l3.realHits > 0 ? cache.l3.realRate : l3.hits} format={cache.l3.realHits > 0 ? pct : fmt} /></span>
          </div>
          <span className="cc-desc">消息只追加不重写 → KV cache</span>
          <span className="cc-meta">
            真实命中 {fmt(cache.l3.realTokens ?? 0)} tok
            {cache.l3.realHits > 0 ? ` · 命中率 ${pct(cache.l3.realRate)}` : ' · 估算 ' + fmt(l3.tokens ?? 0) + ' tok'}
          </span>
          {/* L3 条：有 provider 真实命中时按真实命中率给宽度；无真实反馈时不编造百分比 */}
          <div className="cc-bar"><div className={`cc-bar-fill${cache.l3.realHits > 0 ? '' : ' cc-bar-na'}`} style={{ width: cache.l3.realHits > 0 ? `${Math.max(0, Math.min(100, cache.l3.realRate))}%` : '0%' }} /></div>
          <span className="cc-example">多轮对话输入成本按 provider 折扣计费</span>
        </div>
      </motion.div>

      <motion.div variants={fadeUp} className="global-stats">
        <div className="gs-item">
          <span className="gsi-label">会话</span>
          <span className="gsi-value"><AnimatedNumber value={overview.sessions} format={fmt} /></span>
          <span className="gsi-sub">历史累计</span>
        </div>
        <div className="gs-item">
          <span className="gsi-label">消息</span>
          <span className="gsi-value"><AnimatedNumber value={overview.messages} format={fmt} /></span>
          <span className="gsi-sub">用户 + 助手</span>
        </div>
        <div className="gs-item">
          <span className="gsi-label">TOKENS</span>
          <span className="gsi-value"><AnimatedNumber value={overview.tokensIn + overview.tokensOut} format={fmt} /></span>
          <span className="gsi-sub">in {fmt(overview.tokensIn)} · out {fmt(overview.tokensOut)}</span>
        </div>
        <div className="gs-item">
          <span className="gsi-label">成本</span>
          <span className="gsi-value teal"><AnimatedNumber value={overview.cost} format={cost} /></span>
          <span className="gsi-sub">已含缓存节省</span>
        </div>
        <div className="gs-item">
          <span className="gsi-label">截断次数</span>
          <span className="gsi-value orange"><AnimatedNumber value={overview.truncations} format={fmt} /></span>
          <span className="gsi-sub">上下文超限自动截断</span>
        </div>
      </motion.div>

      <motion.div variants={fadeUp} className="set-sec">
        <span className="ss-title">本次运行（进程内累计）</span>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">执行步骤</span><span className="set-row-desc">LLM 调用 + 工具调用 + 缓存命中</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}><AnimatedNumber value={process.steps} format={fmt} /></span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">LLM 调用</span><span className="set-row-desc">实际请求模型次数</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}><AnimatedNumber value={process.llmCalls} format={fmt} /></span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">工具调用</span><span className="set-row-desc">Agent 执行工具次数</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}><AnimatedNumber value={process.toolCalls} format={fmt} /></span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">本次成本</span><span className="set-row-desc">进程内累计（含缓存折扣）</span></div>
          <span className="sc-val teal" style={{ fontSize: 16 }}><AnimatedNumber value={process.cost} format={cost} /></span>
        </div>
      </motion.div>

      <motion.div variants={fadeUp} className="set-sec">
        <span className="ss-title">上下文质量（context rot 诊断）</span>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">上下文注入</span><span className="set-row-desc">context provider 按需注入次数</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}><AnimatedNumber value={q.injections} format={fmt} /></span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">摘要压缩</span><span className="set-row-desc">LLM 摘要压缩早期历史（信息保鲜）</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}><AnimatedNumber value={q.compactions} format={fmt} /></span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">截断</span><span className="set-row-desc">超预算物理丢弃较早消息</span></div>
          <span className="sc-val orange" style={{ fontSize: 16 }}><AnimatedNumber value={q.truncations} format={fmt} /></span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">模型路由</span><span className="set-row-desc">按任务复杂度切换模型次数</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}><AnimatedNumber value={q.modelRoutes} format={fmt} /></span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">思考预算降级</span><span className="set-row-desc">reasoning 超限注入收敛提示次数</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}><AnimatedNumber value={q.reasoningHints} format={fmt} /></span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">工具面</span><span className="set-row-desc">{q.toolDefinitions} 个工具 · 描述+参数约 {fmt(q.toolDefBytes)} B（confusion 风险信号）</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}><AnimatedNumber value={q.toolDefinitions} format={fmt} /></span>
        </div>
      </motion.div>
      </motion.div>
    </div>
  );
}
