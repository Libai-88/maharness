/**
 * server/routes/chat.ts —— 对话（SSE 流式）+ 断点状态查询
 * H3 同会话互斥：同一会话同时只允许一个 run；占用中直接 409（finally 释放）。
 * M3：beginRun/endRun 告知 index 的自动停止机制「有活跃 run」——页面全关也不腰斩任务。
 * 对话策略通过 chat service interface 访问（kernel 服务注册表），不直接 import core/chat 子模块。
 */
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { LLMMessage, LLMRole } from '../../kernel/types';
import type { Message, Session } from '../../kernel/types';
import { truncateHistory } from '../context';
import { beginRun, endRun } from '../index';
import { getChatService, sse, type RouteDeps } from './shared';
import { scheduleWarmup } from './warmup';

// ---- H3 同会话互斥：同一会话同时只允许一个 run ----
// 并发 chat 会交叉写历史（onHistorySync 顺序不可控）、双份计费、断点互相覆盖。
const inFlightSessions = new Map<string, true>();

// ---- H13 成本预警的前缀标记：历史已含同款预警则不重复追加 ----
const COST_WARNING_MARK = '【成本预警】';

export function registerChatRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;

  // ---------- 断点状态查询（前端可据此显示「继续任务」入口） ----------
  app.get('/api/sessions/:id/checkpoint', (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const cp = store.loadCheckpoint(session.id);
    res.json({
      exists: !!cp,
      turn: cp?.turn ?? 0,
      historyMessages: cp?.history.length ?? 0,
      createdAt: cp?.createdAt ?? 0,
    });
  });
  // ---------- 对话（SSE 流式；body.resume=true 时从断点历史继续） ----------
  app.post('/api/sessions/:id/chat', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    if (inFlightSessions.has(session.id)) return res.status(409).json({ error: '该会话有任务进行中' });
    inFlightSessions.set(session.id, true);
    beginRun();
    try {
      await runChat(req, res, session);
    } finally {
      inFlightSessions.delete(session.id);
      endRun();
    }
  });

  // runChat 内部的提前返回直接返回 Express 响应对象（void | Response）
  const runChat = async (req: Request, res: Response, session: Session): Promise<void | Response> => {
    const { message, model, provider: providerId, systemPrompt: systemPromptParam, resume } = req.body ?? {};
    // 断点续跑：resume=true 时不需要新消息，从断点历史继续（中断的任务不白跑）
    if (!resume && !message?.trim()) return res.status(400).json({ error: '消息不能为空' });
    // 编码防御：拒绝含替换符/孤立代理项的消息（防外部工具写入乱码）
    if (!resume && (/\uFFFD/.test(message) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/.test(message))) {
      return res.status(400).json({ error: '消息包含无法识别的编码字符，请检查输入编码（应为 UTF-8）' });
    }

    const chat = getChatService(kernel);
    if (!chat) return res.status(500).json({ error: '对话服务未加载' });
    const provider = chat.providers.find((p) => p.id === providerId) ?? chat.providers[0];
    if (!provider) return res.status(500).json({ error: '未配置 LLM Provider，请先配置 .env' });
    const resolvedModel = model || session.model || provider.defaultModel;
    // 经济性（harness 管理认知资源）：会话累计成本超预算 → 注入成本警告
    // （不是"请 LLM 自觉节约"，而是 harness 直接告诉它预算边界）
    // M1：成本汇总走 SQL 聚合（不再全量 listMessages 拉消息正文）
    const sessionCost = store.aggregateSessions().find((a) => a.sessionId === session.id)?.cost ?? 0;
    const costBudget = kernel.config.get<number>('budget.maxSessionCost', 0);
    // 会话级成本硬上限（实时熔断）：总预算 - 会话历史累计 = 本任务剩余预算。
    // 剩余 ≤ 0 时不传（runner 不熔断——历史已超预算时由下方警告提示收敛，避免卡死续跑）。
    const remainingBudget = costBudget > 0 ? costBudget - sessionCost : 0;
    // H13 成本预警改为「history 末尾追加 system 消息」而非拼进 systemPrompt：
    // systemPrompt 是全部历史的公共前缀，拼预警会击穿整个前缀缓存（每次预警重付全价
    // prefill）；追加式只付一次「新增消息」的代价，且预警随 onHistorySync 入库成为
    // 历史的一部分（下一 run 检测到已含预警则不重复追加）。
    const costWarningText = costBudget > 0 && sessionCost > costBudget
      ? `${COST_WARNING_MARK}本会话累计成本 $${sessionCost.toFixed(5)} 已超过预算 $${costBudget.toFixed(5)}：请立即收敛——停止探索性工具调用，直接给出结论；如需继续深入，请告知用户新建会话。`
      : '';
    /** 历史未含成本预警时追加一条（去重依据：COST_WARNING_MARK 前缀的 system 消息） */
    const appendCostWarning = (hist: LLMMessage[]): LLMMessage[] => (
      costWarningText && !hist.some((m) => m.role === 'system' && (m.content ?? '').startsWith(COST_WARNING_MARK))
        ? [...hist, { role: 'system', content: costWarningText }]
        : hist
    );
    // 系统提示词：三层组装（L0 框架 + L1 用户人设 + L2 插件自述）+ 会话模式注入；body.systemPrompt 可临时覆盖（调试）
    const modePrompt = chat.MODE_PROMPTS[session.mode];
    // 世界状态（context）：LLM 需要知道自己身处的世界——工作区、模式、可用工具、模型。
    // 内容只含会话内稳定事实（不含时间戳等易变项），同一会话内字节级稳定，
    // 不破坏 L3 前缀缓存；工作区/模式变更时内容随之更新（前缀失效一次，符合"世界变了"）。
    const sandboxNow = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
    const worldState = [
      '【世界状态】',
      `- 沙箱根目录（工作区，文件工具路径相对此）: ${sandboxNow}`,
      `- 会话模式: ${session.mode}${modePrompt ? `（${modePrompt.replace(/^【当前模式：[^】]+】/, '').slice(0, 40)}…）` : ''}`,
      `- 模型: ${resolvedModel}`,
    ].join('\n');
    const baseSystemPrompt = (typeof systemPromptParam === 'string' && systemPromptParam.trim()
      ? systemPromptParam
      : chat.getSystemPrompt()) + (modePrompt ? `\n\n${modePrompt}` : '');

    // 角色接管（handoff）：会话处于某角色时，角色提示词置于最前（引导力最强），
    // 通用规则保留在后；角色工具集按声明过滤（readonly=只读白名单）。
    // 角色与模式正交：plan/goal 模式提示词照常注入，角色只管身份与工具边界。
    // 取舍说明：与 H13 的成本预警不同，roleDef 前置 systemPrompt 有意保留——
    // 角色切换 = 世界状态变更（接管者身份变了，全部历史都应在新身份语境下重读），
    // 本质是一次性前缀重建代价；sessions.role 持久化后角色在会话存续期稳定，
    // 重建后的前缀持续命中，不会像「每次超预算都变」的成本预警那样反复击穿缓存。
    const roleDef = session.role
      ? kernel.plugins.capabilities('role').find((c) => c.role.id === session.role)?.role
      : undefined;
    const systemPrompt = roleDef
      ? `${roleDef.systemPrompt}\n\n（以下为通用规则，与角色纪律冲突时以角色纪律为准）\n${baseSystemPrompt}`
      : baseSystemPrompt;

    // 计划模式状态机：1=待出计划（不注入工具，强制先出计划）→ 2=已出计划待确认（放行工具）→ 0
    const planPending = session.planPending ?? 0;
    const roleToolsOverride = roleDef?.tools === 'readonly'
      ? kernel.plugins.capabilities('tool').map((c) => c.tool).filter((t) => chat.ROLE_READONLY_TOOLS.has(t.name))
      : undefined;
    const toolsOverride = session.mode === 'plan' && planPending === 1 ? [] : roleToolsOverride;

    // 历史组装：DB 消息 → LLM 消息（完整重建：assistant 的 tool_calls 与 tool 回填
    // 全部保留——跨 run 请求序列字节级一致，L3 provider 前缀缓存持续命中；
    // system 消息（【历史摘要】/截断说明）也保留：它们是压缩持久化的产物）。
    // 配对修复：中断可能留下「assistant 带 tool_calls 但工具未执行」的残轮
    // （onHistoryMessage 在工具执行前已入库）——未配对的 tool_calls 剥离，
    // 否则 provider 校验失败（OpenAI 兼容要求 tool_calls 后有对应 tool 消息）。
    function buildHistory(rows: Message[]): LLMMessage[] {
      // 组装原始序列（system 保留、assistant 保留 tool_calls 配对、tool 保留 tool_call_id），
      // 然后统一走共享 textualizeHistory——与 run 内发送形态完全一致（纯文本 + user 结尾）
      const raw: LLMMessage[] = [];
      for (const m of rows) {
        if (m.role === 'system') {
          raw.push({ role: 'system', content: m.content });
          continue;
        }
        if (m.role === 'tool') {
          raw.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' });
          continue;
        }
        const base: LLMMessage = { role: m.role, content: m.content };
        if (m.role === 'assistant' && m.toolCalls?.length) {
          // 配对修复：中断可能留下「assistant 带 tool_calls 但工具未执行」的残轮
          const ids = new Set(rows.filter((x) => x.role === 'tool' && x.toolCallId).map((x) => x.toolCallId));
          const paired = m.toolCalls.filter((c) => ids.has(c.id));
          if (paired.length) base.tool_calls = paired;
        }
        raw.push(base);
      }
      return chat.textualizeHistory(raw);
    }
    let history: LLMMessage[];
    if (resume) {
      // 断点续跑：用 checkpoint 的完整历史（含工具回填），末尾加恢复提示——
      // 恢复语义 = 从最后一轮继续决策，不追加用户消息、不落库（续跑结果由后续轮次落库）
      const cp = store.loadCheckpoint(session.id);
      if (!cp || !cp.history.length) return res.status(404).json({ error: '该会话没有可恢复的断点（任务已完成或从未中断）' });
      // 断点完整性校验：assistant 的 tool_calls 必须与 tool 回填配对、tool 消息必须带
      // tool_call_id——否则 provider 校验失败（旧版本遗留的缺字段断点直接报错白跑）。
      // 不一致 → 清除该断点并明确告知（用户重新发起任务即可），而不是把坏数据发给 LLM。
      const invalid = chat.validateCheckpointHistory(cp.history);
      if (invalid) {
        store.clearCheckpoint(session.id);
        return res.status(400).json({ error: `${invalid}——该断点已清除，请重新发起任务` });
      }
      history = [
        ...cp.history as LLMMessage[],
        { role: 'system', content: '【任务恢复】任务曾被中断，请从断点继续完成未竟的目标；已有观察（工具结果）在上下文中可直接使用。' },
      ];
      // H13：断点续跑同样注入成本预警（超预算的续跑更应收敛）
      history = appendCostWarning(history);
    } else {
      history = buildHistory(store.listMessages(session.id));
      // H13：成本预警追加在最新 user 消息之前（保持「user 结尾」的缓存友好形态）
      history = appendCostWarning(history);
      history.push({ role: 'user', content: message });
      store.addMessage({ sessionId: session.id, role: 'user', content: message });
      if (session.title === '新会话') store.updateSession(session.id, { title: message.slice(0, 30) });
    }

    const traceId = randomUUID();
    const ac = new AbortController();
    // 上下文管理 v2：超预算时优先 LLM 摘要压缩（compact：旧对话变【历史摘要】，不丢事实），
    // 压缩不可用/失败才截断（truncate：丢弃较早消息并注入说明）。
    // 对标 Anthropic context compaction——截断是物理删除，压缩是信息保鲜。
    // 压缩结果持久化回 DB：长会话只在首次超预算时压缩一次，后续 run 直接复用
    // （否则每次提问都重新压缩 = 每轮一次全量 LLM 调用 + 前缀重建，成本失控）。
    const maxCtx = kernel.config.get<number>('context.maxTokens', 60000);
    const compactEnabled = kernel.config.get<boolean>('context.compact', true);
    let ctxHistory: LLMMessage[];
    let ctxMode: 'none' | 'compact' | 'truncate' = 'none';
    let droppedMessages = 0;
    if (compactEnabled) {
      const r = await chat.compactHistory(history, maxCtx, { provider, model: resolvedModel, signal: ac.signal, traceId, trace: kernel.trace });
      ctxHistory = r.messages;
      ctxMode = r.mode;
      droppedMessages = r.droppedMessages;
    } else {
      const r = truncateHistory(history, maxCtx);
      ctxHistory = r.messages;
      ctxMode = r.truncated ? 'truncate' : 'none';
      droppedMessages = r.droppedMessages;
    }
    if (ctxMode === 'truncate') {
      kernel.trace.startStep({ traceId, turn: 0, type: 'system', name: '上下文截断' })
        .finish({ outputSummary: `超出预算（${maxCtx} tokens），已丢弃 ${droppedMessages} 条较早消息` });
    }
    // 压缩/截断持久化：把处理后的消息序列写回 DB（摘要/说明 + 保留消息，字段完整）。
    // 下次 run 组装即得压缩后历史——不重复压缩、前缀在重建后持续稳定。
    // 写回失败不阻断对话（仅损失一次压缩的复用）。
    if (ctxMode !== 'none') {
      try {
        const oldRows = store.listMessages(session.id);
        // 尽力复制原消息的 tokens/cost 统计（按 role+content 匹配，压缩后统计不丢）
        const meta = new Map(oldRows.map((r) => [`${r.role}|${r.content}`, r]));
        // H4：事务化回写（delete + 批量 insert 单事务）——中途失败整体回滚，
        // 不再出现「旧消息已清、新消息未写完」的丢历史窗口
        store.replaceSessionMessages(session.id, ctxHistory.map((m) => {
          const old = meta.get(`${m.role}|${m.content}`);
          return {
            role: m.role,
            content: m.content,
            ...(m.role === 'assistant' && m.tool_calls?.length ? { toolCalls: m.tool_calls } : {}),
            ...(m.role === 'tool' ? { toolCallId: m.tool_call_id } : {}),
            tokensIn: old?.tokensIn ?? 0,
            tokensOut: old?.tokensOut ?? 0,
            cost: old?.cost ?? 0,
            traceId: old?.traceId,
          };
        }));
      } catch (err) {
        console.warn('[routes] 压缩结果持久化失败（不影响本次对话）:', err instanceof Error ? err.message : String(err));
      }
    }
    // 客户端断开才中断（req close 在请求体读完即触发，不可用）
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // SSE 心跳：审批等待等长挂起场景防代理/客户端超时断开
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已关闭 */ } }, 15000);
    res.on('close', () => clearInterval(heartbeat));
    sse(res, 'start', { traceId });

    let assistantText = '';
    let assistantReasoning = '';
    let usage = { input: 0, output: 0 };
    let cost = 0;
    // 最终 assistant 消息已通过 onHistoryMessage 入库（id 记录于此）：
    // run 结束后仅回填 tokens/cost/reasoning，避免同内容消息重复入库
    let lastAssistantId: string | null = null;
    // 发送序列累积（用于预热：run 结束后用同一前缀主动刷新网关缓存）
    const seqAcc: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[] = [];
    try {
      // 轮数上限按模式分配（配置可调）：目标模式=长任务（计划→执行→验证→总结），
      // 上限显著放宽；普通模式防无限循环（默认 12）。超限后断点仍在，可继续推进。
      const maxTurnsByMode: Record<string, number> = {
        goal: kernel.config.get<number>('agent.maxTurnsGoal', 48),
        plan: kernel.config.get<number>('agent.maxTurnsPlan', 24),
        normal: kernel.config.get<number>('agent.maxTurns', 12),
      };
      for await (const ev of chat.runner.run({
        provider, model: resolvedModel, messages: ctxHistory, contextMessages: [{ role: 'system', content: worldState }], traceId,
        maxTurns: maxTurnsByMode[session.mode] ?? 12,
        // L1 会话级缓存作用域：稳定会话 ID——同一会话多次提问共享"会话自产答案"，
        // 不同会话互不串用（答案依赖工具观察时仅本会话可命中）
        scope: session.id,
        // 工具上下文会话 ID：todo 等插件把状态挂到具体会话
        sessionId: session.id,
        signal: ac.signal, systemPrompt, tools: toolsOverride,
        // P 契约：注入 server 侧压缩能力（封装 compact.ts）——agent 每轮预算检查
        // 超限时调用 compactFn 就地压缩历史（长任务不被上下文窗口卡死）。
        // 契约签名：compactFn?: (history) => Promise<HistoryMsg[]>（agent 侧由并行任务实现调用）。
        compactFn: (history: LLMMessage[]) => chat.compactHistory(
          history,
          kernel.config.get<number>('context.maxTokens', 60000),
          { provider, model: resolvedModel, signal: ac.signal, traceId, trace: kernel.trace },
        ).then((r) => r.messages),
        // 失败恢复：备用 provider（主服务宕机/限流时自动切换，LLM 无感）
        fallbackProviders: chat.providers.filter((p) => p.id !== provider.id),
        // 成本实时熔断：剩余预算传执行器，超限强制停止（harness 硬边界）
        costBudget: remainingBudget > 0 ? remainingBudget : undefined,
        // 断点续跑：每轮工具执行完自动持久化完整历史（中断不白跑；resume 从断点继续）。
        // 必须存完整字段（tool_calls/tool_call_id 配对），否则恢复时 provider 校验失败。
        onCheckpoint: (turn, hist) => {
          store.saveCheckpoint(session.id, turn, hist.map((m) => ({
            role: m.role, content: m.content ?? null,
            tool_calls: m.tool_calls, tool_call_id: m.tool_call_id,
          })));
        },
        // 发送序列快照同步（assistant 含 tool_calls / tool 含 tool_call_id / 注入消息）：
        // DB = 发送序列的忠实镜像 → 跨 run 组装与上 run 序列构成纯追加 → L3 前缀逐字节延续。
        onHistorySync: (msgs) => {
          try {
            for (const m of msgs) {
              // history[0]（system prompt）已被 syncedCount 排除；此处所有 system 消息
              // （英文提醒/角色移交等）均为发送序列的忠实组成，全部入库
              seqAcc.push({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id });
              const saved = store.addMessage({
                sessionId: session.id,
                role: m.role as LLMRole,
                content: m.content,
                ...(m.role === 'assistant' && m.tool_calls?.length ? { toolCalls: m.tool_calls } : {}),
                ...(m.role === 'tool' ? { toolCallId: m.tool_call_id } : {}),
              });
              if (m.role === 'assistant') lastAssistantId = saved.id;
            }
          } catch (err) {
            console.warn('[routes] 发送序列同步入库失败:', err instanceof Error ? err.message : String(err));
          }
        },
      })) {
        if (ev.type === 'delta') {
          assistantText += ev.text;
          sse(res, 'delta', { text: ev.text });
        } else if (ev.type === 'reasoning') {
          assistantReasoning += ev.text;
          sse(res, 'reasoning', { text: ev.text });
        } else if (ev.type === 'tool_start') {
          sse(res, 'tool_start', { name: ev.name, args: ev.args });
        } else if (ev.type === 'approval_required') {
          sse(res, 'approval_required', { approvalId: ev.approvalId, name: ev.name, summary: ev.summary, args: ev.args });
        } else if (ev.type === 'retry') {
          // provider 重试/failover：前端作废当前流式残段重新累积（防止残段+全文重复渲染）
          sse(res, 'retry', {});
        } else if (ev.type === 'budget_hit') {
          // 成本熔断：harness 硬边界触发（SSE 推送，前端可展示）
          sse(res, 'budget_hit', { cost: ev.cost, budget: ev.budget });
        } else if (ev.type === 'handoff') {
          // 角色移交：会话控制权交给目标角色（后续对话由该角色提示词/工具集接管）
          store.updateSession(session.id, { role: ev.role });
          sse(res, 'handoff', { role: ev.role, objective: ev.objective });
        } else if (ev.type === 'tool_result') {
          sse(res, 'tool_result', { name: ev.name, summary: ev.summary, ok: ev.ok, stored: ev.stored ?? false });
        } else if (ev.type === 'assistant_done') {
          usage = ev.usage;
          cost = ev.cost;
          // 任务正常完成 → 断点失效（恢复点只对未完成任务有意义）
          store.clearCheckpoint(session.id);
          sse(res, 'done', { content: ev.content, reasoning: ev.reasoning, usage: ev.usage, cost: ev.cost, cached: ev.cached ?? false });
        } else if (ev.type === 'error') {
          sse(res, 'error', { error: ev.error });
        }
      }
    } catch (err) {
      sse(res, 'error', { error: err instanceof Error ? err.message : String(err) });
    }
    if (assistantText && lastAssistantId) {
      // 最终轮已入库（onHistoryMessage）：回填结算字段（tokens/cost/reasoning）
      store.updateMessageStats(lastAssistantId, {
        reasoning: assistantReasoning,
        tokensIn: usage.input, tokensOut: usage.output, cost, traceId,
      });
    } else if (assistantText) {
      // L1 缓存命中路径（无 LLM 轮次，未走 onHistoryMessage）：直接入库
      store.addMessage({
        sessionId: session.id, role: 'assistant', content: assistantText,
        reasoning: assistantReasoning,
        tokensIn: usage.input, tokensOut: usage.output, cost, traceId,
      });
    }
    // 计划模式状态推进：出计划轮完成 → 待确认；确认轮完成 → 回到无限制
    if (session.mode === 'plan' && planPending === 1) store.updateSession(session.id, { planPending: 2 });
    else if (session.mode === 'plan' && planPending === 2) store.updateSession(session.id, { planPending: 0 });
    store.touchSession(session.id);
    // 缓存预热/保活：run 结束后用同一前缀主动刷新网关前缀缓存——
    // 网关对「含 tool_calls 的请求」的缓存建立有延迟/条件限制，且前缀缓存有 TTL；
    // 预热请求（max_tokens=1，成本≈0）主动建立/刷新缓存，把下一次提问的 turn0
    // 也拉入缓存窗口（跨 run 首轮不再全价 prefill）。
    // 预热仅在发送序列足够长时触发（≥3 条消息才有缓存价值；L1 命中的短序列跳过）
    const warmupMode = kernel.config.get<'off' | 'light' | 'auto'>('cache.warmup', 'auto');
    if (seqAcc.length >= 3 && warmupMode !== 'off') {
      scheduleWarmup(session.id, systemPrompt, seqAcc, provider, resolvedModel, kernel, [{ role: 'system', content: worldState }]);
    }
    sse(res, 'end', {});
    res.end();
  };
}
