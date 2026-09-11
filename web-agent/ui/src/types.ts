// ui/src/types.ts —— 前端共享类型
export interface Session {
  id: string;
  title: string;
  model: string;
  /** model 所属 provider id（发送/恢复时需与 model 匹配） */
  provider?: string;
  mode: string;
  planPending: number;
  /** 当前接管角色（handoff）：空 = 主代理；有值 = 该角色接管会话 */
  role?: string;
  archived: number;
  pinned: number;
  createdAt: number;
  updatedAt: number;
  /** 侧栏摘要数据源：最后一句"真正说出口的话"及其角色（服务端派生，非 sessions 列） */
  lastMsg?: string;
  lastRole?: 'user' | 'assistant';
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  reasoning?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  createdAt: number;
  /** 原生工具调用（assistant 行）：演出重建的数据源——刷新后工具卡/群成员靠它复原 */
  toolCalls?: { id: string; type?: string; function: { name: string; arguments?: string } }[];
  /** tool 行回填所对应的 tool_call_id（与 assistant.toolCalls[].id 配对） */
  toolCallId?: string;
  /** 一次 run 的关联键（结算回填后才有） */
  traceId?: string;
}

export interface ModelInfo {
  /** provider@model（新旧 UI 兼容） */
  id: string;
  /** 纯 provider id：旧版前端按此匹配，新前端也用它解析 */
  provider: string;
  label: string;
  model: string;
}

export interface ModelCapabilityInfo {
  modelId: string;
  contextWindow: number | null;
  maxOutput: number | null;
  vision: number;
  tools: number;
  reasoning: number;
  priceIn: number | null;
  priceOut: number | null;
  enabled: number;
  source: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  protocol?: string;
  priceIn?: number | null;
  priceOut?: number | null;
  enabled: boolean;
  apiKeyMasked: string;
  hasKey: boolean;
  createdAt: number;
  updatedAt: number;
  models?: ModelCapabilityInfo[];
  /** 健康状态（failover 链真实调用回报）：401/403 → authFailed（需人工换 key） */
  health?: { failures: number; authFailed: boolean; lastError: string; lastErrorAt: number };
}

/** /api/providers/models 拉取结果（含推断能力，用于免手填） */
export interface PulledModel {
  id: string;
  label?: string;
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  priceIn: number;
  priceOut: number;
  source: string;
}

export interface ProviderForm {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol?: string;
  priceIn?: string;
  priceOut?: string;
}

export interface PersonaInfo {
  id: string;
  name: string;
  content: string;
  enabled: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface BusEvent {
  type: string;
  traceId?: string;
  data?: unknown;
  ts: number;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  state: string;
  caps: string[];
  error?: string;
  fixSuggestion?: string;
  essential?: boolean;
  circuitBreaker?: { failures: number; openedAt: number };
}

/**
 * 插件贡献的前端标签页（来自 GET /api/nav）。
 * 前端不再为每个插件写组件与分支——插件在 plugin.json 声明 nav 即拥有自己的一页。
 */
export interface PluginNavItem {
  /** 稳定 key：plugin:<pluginId> */
  key: string;
  pluginId: string;
  pluginName: string;
  label: string;
  icon: string | null;
  order: number;
  mode: 'iframe' | 'panel' | 'module';
  /** iframe → 直接作 src；panel → 取回 { title, html }；module 模式为空 */
  url: string;
  /** module 模式：插件前端模块入口（含内容哈希），动态 import 后调用其 mount(container, host) */
  moduleUrl: string | null;
  /** 页头状态轮询端点（返回 { text, detail?, connected? }）；null = 不展示状态 */
  statusUrl: string | null;
  statusIntervalMs: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'pack' | 'project';
  /** 同名技能被更高优先级来源覆盖时列出被覆盖的来源 */
  shadowed?: string[];
  license?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
  bodyChars?: number;
}

/** 自进化：任务后产出的技能提案（采纳才生效） */
export interface SkillProposal {
  id: string;
  name: string;
  description: string;
  reason: string;
  signals: string[];
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  updatedAt: number;
  seen: number;
  question?: string;
  evidence?: string;
}

/** skills-lock.json 中一条可同步项 */
export interface LockSkill {
  name: string;
  source: string;
  sourceType: string;
  skillPath: string;
  computedHash?: string;
  installed: boolean;
}

export interface SkillUsageRow {
  indexShown: number;
  reads: number;
  bodyTokens: number;
  lastReadAt?: number;
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  current: boolean;
}

export interface TreeEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
}

/** 斜杠命令（命令面板渲染用） */
export interface CommandInfo {
  name: string;
  usage: string;
  description: string;
  source: 'builtin' | 'plugin';
}

/** 统计面板：全局概览 / 进程 / 上下文用量 / 缓存命中率 */
export interface StatsInfo {
  overview: {
    sessions: number;
    messages: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    truncations: number;
    cacheHitSteps: number;
  };
  process: {
    steps: number;
    llmCalls: number;
    toolCalls: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
  };
  context: {
    maxTokens: number;
    /** F：上下文质量监控（context rot 诊断）——进程内近端上下文事件计数与工具面指标 */
    quality: {
      injections: number;
      compactions: number;
      truncations: number;
      modelRoutes: number;
      reasoningHints: number;
      toolDefinitions: number;
      toolDefBytes: number;
    };
    perSession: {
      id: string;
      title: string;
      mode: string;
      messages: number;
      tokensIn: number;
      tokensOut: number;
      cost: number;
      estimatedTokens: number;
      contextBudget: number;
      contextUsage: number;
      truncated: boolean;
      truncations: number;
    }[];
  };
  /** 任务画像（harness 自适应数据源）：类型 → 次数/平均轮数/成本/失败率 */
  taskProfile: { type: string; count: number; avgTurns: number; avgCost: number; failRate: number }[];
  cache: {
    l1Enabled: boolean;
    l1: { hits: number; misses: number; rate: number };
    l2: { hits: number; misses: number; rate: number };
    /** L3 双口径：hits/tokens 为本地估算（相邻调用公共前缀）；real* 为 provider usage 确认的真实命中 */
    l3: {
      hits: number; tokens: number;
      realHits: number; realTokens: number; realMissTokens: number; realRate: number;
    };
    savedCost: number;
    overall: { served: number; total: number; rate: number };
  };
}

export interface TraceStep {
  id: string;
  traceId: string;
  turn: number;
  type: 'llm_call' | 'tool_call' | 'cache_hit' | 'user_msg' | 'system';
  name?: string;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  cacheKey?: string;
  cacheLayer?: string;
  /** 父步骤 id（span 树）：子代理/并行子任务挂到调用方工具步骤下，可跨 traceId 下钻 */
  parentId?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  ts: number;
  endTs?: number;
}

// 前端会话中的本地消息（含流式状态与工具调用过程）
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';   // system = 斜杠命令等系统提示
  content: string;
  reasoning?: string;       // 思考过程（推理模型）
  streaming?: boolean;
  tools?: ToolStep[];
  /** 旁白：模型在"决定调工具"的那些轮里说出口的话（多为英文工作日志）。
   *  它不是给用户的答复，所以不混在正文气泡里；但它确实发生过，所以留在演出里
   *  （折叠在气泡上方的"它当时在想/说什么"）。实时与刷新两路由同一规则生成。 */
  narration?: string[];
  /** 用户主动打断（点停止）：画成一条温和的系统条，而不是红色报错 */
  stopped?: boolean;
  /** provider 重试（retry）的正文截断边界：从该偏移起重新累积（挂在消息上，不再用并行 Record） */
  retryFrom?: number;
  /** 同上，作用于 reasoning 区 */
  retryFromReasoning?: number;
  error?: string;
  /** 技术原文（人话文案放 error，原文进 title/控制台） */
  errorRaw?: string;
  usage?: { input: number; output: number };
  cost?: number;
  cached?: boolean;         // L1 语义缓存命中（零 LLM 成本直接回答）
  /** 微信式系统提示种类：join = 「邀请 XX 加入群聊」（子代理入群） */
  sysKind?: 'join';
  /** join 消息中被邀请入群的成员名 */
  member?: string;
  /** 消息时间戳（微信式时间分隔线用；历史消息映射 createdAt） */
  ts?: number;
}

/** 子代理类工具 → 群成员名（微信群聊隐喻：调用子代理 = 邀请成员入群） */
export function subagentLabel(name: string, args: unknown): string | null {
  const a = (args ?? {}) as { objective?: string; target?: string; mode?: string };
  if (name === 'run_subagent') {
    const obj = String(a.objective ?? '').trim();
    return obj ? `子代理 · ${obj.slice(0, 12)}${obj.length > 12 ? '…' : ''}` : '子代理';
  }
  if (name === 'run_review') return '独立审查者';
  if (name === 'run_parallel') return '并行小队';
  return null;
}

/** 是否子代理类工具（群成员发言渲染） */
export function isSubagentTool(name: string): boolean {
  return name === 'run_subagent' || name === 'run_review' || name === 'run_parallel';
}

/** 工具 → 会话头活动状态（像朋友的微信签名：让用户知道 agent 正在忙什么） */
export function toolActivityLabel(name: string): string {
  switch (name) {
    case 'list_dir':
    case 'glob':
      return '正在翻文件…';
    case 'read_file':
      return '正在细看文件…';
    case 'grep':
      return '正在逐行翻找…';
    case 'web_search':
      return '正在查资料…';
    case 'web_fetch':
      return '正在打开网页…';
    case 'write_file':
    case 'edit_file':
      return '正在动笔写…';
    case 'powershell_execute':
      return '正在敲命令…';
    case 'run_subagent':
      return '正在等帮手干完活…';
    case 'run_review':
      return '审查者正在把关…';
    case 'run_parallel':
      return '小队正在分头行动…';
    case 'remember_fact':
    case 'recall_facts':
    case 'list_memory_blocks':
      return '正在翻记忆…';
    case 'list_skills':
    case 'get_skill':
    case 'get_skill_file':
      return '正在翻技能手册…';
    default:
      return '正在忙…';
  }
}

/** 由任意字符串稳定生成色相（0-359）：会话/群成员涂鸦头像配色 */
export function hueFrom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export interface ToolStep {
  /** tool_call_id：start/result 精确配对（同名并发调用不串卡）。实时与重建两路共用。 */
  id?: string;
  name: string;
  args?: unknown;
  summary?: string;
  ok?: boolean;
  status: 'running' | 'done' | 'error';
  /** 执行开始时间戳（前端计时用） */
  startedAt?: number;
  /** 执行耗时（毫秒，onToolResult 结算） */
  durationMs?: number;
  /** 大结果已存入结果存储（recall_tool_result 可零副作用重读） */
  stored?: boolean;
}

export interface ApprovalItem {
  id: string;
  name: string;
  summary: string;
  /** 所属会话：刷新后据此把审批卡放回正确的聊天窗口 */
  sessionId?: string;
  /** 提交时刻（"等了多久"）与自动作废时刻（服务端 10 分钟超时） */
  createdAt?: number;
  expiresAt?: number;
}

/** 断点状态（checkpoint：任务中断后可继续） */
export interface CheckpointInfo {
  exists: boolean;
  turn: number;
  historyMessages: number;
  createdAt: number;
}

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface PlanState {
  objective: string;
  steps: { title: string; status: StepStatus; note?: string }[];
  current: number;
  completed: boolean;
  createdAt: number;
}

/** todo 插件：待办看板 / 模型 to do list 卡片 */
export type TodoStatus = 'todo' | 'doing' | 'done' | 'blocked';
export type TodoPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface TodoCard {
  id: string;
  title: string;
  desc?: string;
  status: TodoStatus;
  priority: TodoPriority;
  source: 'agent' | 'human';
  sessionId?: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

/** workbench 插件：办公工作台 v2（嵌入式全量应用 + 文件桥联动） */
export type WbRepeat = 'daily' | 'weekdays' | 'weekly';
export type WbProjectStatus = 'active' | 'paused' | 'done';

/** 旧类型保留（向后兼容 /state 端点面板；插件页面现由 PluginTabView + nav 声明渲染） */
export interface WbTask {
  id: string;
  title: string;
  notes?: string;
  date: string;
  time?: string;
  done: boolean;
  doneAt?: number;
  projectId?: string;
  repeat?: WbRepeat;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface WbProject {
  id: string;
  name: string;
  desc?: string;
  color: string;
  status: WbProjectStatus;
  deadline?: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface WbState {
  today: string;
  tasks: WbTask[];
  projects: WbProject[];
}

/** 文件桥状态（工作台联动状态条使用） */
export interface BridgeInfo {
  ok: boolean;
  connected: boolean;
  dir: string;
  file: string;
  records: { tasks: number; notes: number; projects: number };
  lastSavedAt: string | null;
  lastExternalAt: number;
  mtimeMs: number;
}
