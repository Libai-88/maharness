// ui/src/voice.ts —— 「小马」人设文案中心
// 宗旨：这是一个像朋友一样聊天的界面。所有系统话术从这里出，不散落在组件里。
// 三条铁律：
//   1) 用户看到的永远是"人话"，技术原文进 title/console（可查，但不糊在脸上）；
//   2) 取消 ≠ 出错：用户按「停止」绝不能被画成一条红色报错；
//   3) 一句人话后面必须跟"那我现在能干什么"（可操作动作，而不是报错码）。
import type { ToolStep } from './types';

/** 对手方的名字：模型自己也这么自称（"我是 maharness，你可以叫我小马"） */
export const AGENT_NAME = '小马';
export const AGENT_ID = 'maharness';

/** 界面显示的版本号：唯一出处（此前 side-bar 里硬编码的 v0.1.2 与 package.json 的
 *  0.1.0 已经不一致了——版本号只该有一个地方能写错）。发版时与 ui/package.json 同改。 */
export const APP_VERSION = '0.1.0';

/** 系统条（居中灰字）文案 —— 微信式"系统提示"的口气 */
export const sys = {
  /** 用户打断：不指责、不报错，留一个"随时能接着说"的口子 */
  stopped: `你打断了${AGENT_NAME}——说了一半的话还在上面，随时可以让我接着说`,
  resumed: `${AGENT_NAME}接着上次没说完的地方继续…`,
  handoff: (role: string, objective: string) => `这活儿交给「${role}」了：${objective.slice(0, 80)}`,
  backToMain: `已经换回${AGENT_NAME}本人`,
  join: (member: string) => `${member} 加入了群聊`,
  started: `${AGENT_NAME}正在输入…`,
  offline: '跟后端的连线断了一下，正在重连…',
  online: '重连上了，继续',
  busy: `${AGENT_NAME}还在忙上一件事，说完这句它会接上的`,
  cleared: '这里的记录清空了（服务端历史还在）',
  modeSet: (label: string) => `好，接下来用${label}`,
  modelSet: (model: string) => `换用 ${model} 来想事情`,
  commandFailed: (why: string) => `这件事我没办成：${why}`,
  /** 审批等到超时自动作废（服务端 10 分钟） */
  approvalExpired: (tool: string) => `那个「${tool}」的请求等太久，已经自动取消了——想让它做的话再说一次就好`,
} as const;

/** 工具名 → 中文名（气泡/卡片上不再出现 read_file 这种函数名） */
const TOOL_NAMES: Record<string, string> = {
  list_dir: '看一眼目录',
  glob: '按名字找文件',
  grep: '在文件里搜一句话',
  read_file: '读一个文件',
  write_file: '写一个文件',
  edit_file: '改一个文件',
  delete_file: '删一个文件',
  powershell_execute: '跑一条命令',
  env_probe: '看了看环境',
  web_search: '上网查了查',
  web_fetch: '打开了个网页',
  run_subagent: '找了个帮手',
  run_parallel: '拉了个小队分头干',
  run_review: '请审查者把关',
  remember_fact: '记到小本本上',
  recall_facts: '翻了翻小本本',
  forget_fact: '忘掉了一条',
  list_memory_blocks: '翻了翻记忆',
  set_memory_block: '整理了记忆',
  delete_memory_block: '清掉了一块记忆',
  get_skill: '翻了一份方法手册',
  get_skill_file: '翻技能参考文件',
  todo_add: '记了条待办',
  todo_update: '勾了条待办',
  todo_list: '看了看待办',
  create_plan: '列了个计划',
  update_plan_progress: '推进了计划',
  complete_goal: '结了个目标',
  create_plugin: '给自己写了个新插件',
  plugin_status: '看了看插件状态',
  read_image: '看了看图',
  analyze_image: '认了认图里的东西',
  recall_tool_result: '重看了之前的结果',
};

export function toolDisplayName(name: string): string {
  return TOOL_NAMES[name] ?? name;
}

/** 工具状态 → 一个字的视觉标签（卡片右侧，替代"执行中/完成/失败"这种系统腔） */
export function toolOutcomeText(t: { status?: string; ok?: boolean }): string {
  if (t.status === 'running') return '在做';
  if (t.status === 'error' || t.ok === false) return '没成';
  return '办好';
}

/** 剥掉工具结果外层的 {ok,data}/{ok,error} 信封，拿到能给人看的正文。
 *  子代理/并行/审查的结果本来就是 JSON——群成员开口不该念一串 JSON。 */
export function describeToolOutcome(name: string, summary: string, ok: boolean): string {
  const raw = (summary ?? '').trim();
  if (!raw) return ok ? '办好了，没留下话' : '没办成，也没说为什么';
  const parsed = tryJson(raw);
  if (parsed) {
    if (ok || parsed.ok !== false) {
      const data = parsed.data ?? parsed;
      const answer = pickText(data, ['answer', 'summary', 'result', 'text', 'message', 'content']);
      if (answer) return answer;
      if (name === 'run_parallel') {
        const rec = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
        const results = Array.isArray(rec.results) ? rec.results as { ok?: boolean }[] : [];
        const done = results.filter((r) => r?.ok !== false).length;
        return results.length ? `${results.length} 路里有 ${done} 路交回了结果` : '小队回来了，但没带话';
      }
      const nested = pickText(parsed, ['summary', 'output', 'note']);
      if (nested) return nested;
      return `${toolDisplayName(name)}：办好了`;
    }
    const why = pickText(parsed, ['error', 'message', 'reason', 'blockReason', 'approvalSummary']);
    return why ? tidySentence(why) : `${toolDisplayName(name)}没成`;
  }
  // 非 JSON：模型/工具写的自然语言，去掉常见前缀后直给
  return tidySentence(raw.replace(/^(子代理失败|审查失败|并行子任务失败|工具不存在)\s*[:：]\s*/, '$1：'));
}

/** 从对象里按候选键取第一段可展示文本 */
function pickText(o: unknown, keys: string[]): string {
  if (!o || typeof o !== 'object') return '';
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function tryJson(s: string): Record<string, unknown> | null {
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v as Record<string, unknown> : null;
  } catch {
    // 工具结果是被 summarize() 截断过的 → JSON 不完整。退一步：用正则把关键字段抠出来。
    const m = s.match(/"(?:answer|summary|error|message|reason)"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m) return null;
    const key = s.match(/"(answer|summary|error|message|reason)"/)?.[1] ?? 'answer';
    const ok = !/"ok"\s*:\s*false/.test(s);
    return { [key]: m[1].replace(/\\"/g, '"').replace(/\\n/g, ' '), ok };
  }
}

/** 长文本压成一句可放进气泡的话 */
export function tidySentence(s: string, max = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export type ErrorKind = 'aborted' | 'budget' | 'max-turns' | 'policy' | 'upstream' | 'network' | 'busy';

export interface HumanError {
  /** 摆在气泡里的人话 */
  text: string;
  /** 可选的补救动作提示（同一行的小字） */
  hint?: string;
  /** 是否该画成"错误"（红色）——取消类一律 false */
  severe: boolean;
}

/** 把后端/传输层的技术错误翻译成人话。原文只进 title 与控制台。 */
export function humanizeError(raw: string, kind?: ErrorKind): HumanError {
  const msg = (raw ?? '').trim();
  if (kind === 'aborted' || msg === '已停止' || msg === '已中断') {
    return { text: '', hint: undefined, severe: false };      // 停止走"系统条"，不走错误
  }
  if (kind === 'busy' || /该会话有任务进行中/.test(msg)) {
    return { text: sys.busy, severe: false };
  }
  if (kind === 'budget' || /成本预算已耗尽/.test(msg)) {
    return { text: '这次说到这儿就停了——预算用完了。已完成的部分都在，接着聊或新建一个都行。', hint: '可在「设置」里调整预算', severe: false };
  }
  if (kind === 'max-turns' || /轮数上限/.test(msg)) {
    return { text: '这个任务有点大，我先把做到哪儿的都留着了。再说一句「继续」，我接着往下推。', severe: false };
  }
  if (kind === 'policy' || /策略拦截/.test(msg)) {
    return { text: `这条路被规则挡住了：${tidySentence(msg, 80)}`, hint: '可在「设置 · 规则」里调整', severe: false };
  }
  if (/密钥|401|403|invalid api key|unauthorized|no access to model/i.test(msg)) {
    return { text: '我这边的一条线路钥匙过期了，已经自动换了一条继续陪你聊。', hint: '有空去「设置」换一下密钥', severe: true };
  }
  if (/连接中断|未见结束标记|网络错误|fetch failed|ECONNRESET|socket hang up|响应无内容|请求失败 0/i.test(msg)) {
    return { text: '话说到一半，线断了一下。再说一句，我从这儿接着来。', severe: true };
  }
  if (/LLM 流异常中断/.test(msg)) {
    return { text: '刚才那句没说完就断了，麻烦你再问一次。', severe: true };
  }
  if (/未配置 LLM Provider|没有可恢复的断点|会话不存在/.test(msg)) {
    return { text: tidySentence(msg.replace(/——.*/, '')), severe: false };
  }
  // 兜底：不把 stack 糊在脸上，但也不假装没事
  return { text: '这件事我没办成。', hint: tidySentence(msg, 60), severe: true };
}

/** 审批卡：把 "需要审批 · powershell_execute" 翻译成"谁、想干什么、要不要放行" */
export function approvalHead(name: string): { title: string; sub: string } {
  return { title: `${AGENT_NAME}想请你点头`, sub: toolDisplayName(name) };
}

/** 会话摘要（侧栏最后一行）：把"私聊"这种占位换成真正的内容预览 */
export function previewOf(role: string | undefined, content: string | undefined): string {
  const c = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!c) return '';
  const who = role === 'assistant' ? `${AGENT_NAME}：` : '';
  return who + tidySentence(c, 34);
}

/** 会话标题展示：服务端存的是第一句话前 30 字，侧栏需要更像"聊天对象的名字" */
export function displayTitle(title: string | undefined): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t === '新会话') return '新会话';
  return t.length > 16 ? `${t.slice(0, 16)}…` : t;
}

/** 微信式时间：刚刚 / N分钟前 / 今天 HH:MM / 昨天 HH:MM / 星期X HH:MM / M月D日 */
export function chatTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const startOfDay = (t: number) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  const diff = now - ts;
  if (dayDiff <= 0) {
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    return hm;
  }
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) return `星期${'日一二三四五六'[d.getDay()]} ${hm}`;
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 货币：全站只用一个符号（模型定价按 USD/1M 计，界面统一 ¥ 会误导——统一用 $ 且只留必要精度） */
export function money(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0';
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

/** 工具步骤（含实时与重建两路）统一取"给人看的一句" */
export function stepLine(t: ToolStep): string {
  return describeToolOutcome(t.name, t.summary ?? '', t.status !== 'error' && t.ok !== false);
}
