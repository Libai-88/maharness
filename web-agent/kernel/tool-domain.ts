/** 工具能力域：稳定、无业务副作用的展示/选择辅助标签。 */
export function toolDomain(name: string): string {
  const n = String(name ?? '').toLowerCase();
  if (n === 'list_dir' || n === 'read_file' || n === 'glob' || n === 'grep'
    || n === 'write_file' || n === 'edit_file' || n === 'delete_file') return 'Files';
  if (n.startsWith('mcp_')) return 'MCP';
  if (n.startsWith('browser_')) return 'Browser';
  if (n.startsWith('web_')) return 'Research';
  if (n.startsWith('lsp_') || n === 'repo_map' || n === 'find_symbol' || n === 'project_diagnostics') return 'Code';
  if (n === 'read_document' || n.startsWith('ocr_')) return 'Document';
  if (n.includes('skill')) return 'Skills';
  if (n.includes('memory') || n === 'remember_fact' || n === 'recall_facts' || n === 'forget_fact' || n === 'revoke_fact') return 'Memory';
  if (n === 'create_plan' || n === 'update_plan_progress' || n === 'complete_goal') return 'Plan';
  if (n.startsWith('todo_')) return 'Tasks';
  if (n === 'run_subagent' || n === 'run_review' || n === 'run_parallel' || n === 'handoff_to') return 'Agents';
  if (n === 'list_rules' || n === 'check_policy') return 'Policy';
  if (n === 'read_image' || n === 'analyze_image') return 'Media';
  if (n === 'create_plugin' || n === 'plugin_status' || n === 'enable_plugin' || n === 'disable_plugin') return 'Plugins';
  if (n === 'powershell_execute' || n === 'env_probe') return 'System';
  if (n.includes('blackboard')) return 'Collaboration';
  return 'General';
}

const DOMAIN_HINTS: Record<string, RegExp> = {
  Files: /(file|files|dir|folder|path|read|write|edit|glob|grep|文件|目录|路径|读取|写入|编辑|删除)/i,
  Research: /(web|search|fetch|crawl|url|http|research|搜索|检索|网页|资料|新闻|抓取)/i,
  Browser: /(browser|click|form|login|page|screenshot|浏览器|点击|表单|登录|页面|截图)/i,
  Code: /(code|typescript|javascript|python|function|symbol|lsp|refactor|代码|函数|符号|重构|调用)/i,
  Document: /(pdf|docx|document|paper|table|ocr|文档|论文|表格|扫描)/i,
  Memory: /(memory|remember|recall|记忆|记住|回忆)/i,
  Skills: /(skill|技能|指南|规范)/i,
  Tasks: /(todo|task|checklist|待办|任务|清单)/i,
  Plan: /(plan|step|goal|计划|步骤|目标)/i,
  Agents: /(subagent|parallel|review|delegate|子代理|并行|审查|委派)/i,
  MCP: /(mcp|server|远程工具)/i,
  Media: /(image|vision|图片|图像|看图)/i,
  Plugins: /(plugin|插件|扩展)/i,
  Policy: /(rule|policy|规则|策略|审批)/i,
  System: /(shell|powershell|command|env|系统|命令|环境)/i,
  Collaboration: /(blackboard|shared|共享|黑板)/i,
};

const BASE_DOMAIN_ORDER = ['Files', 'Plan', 'Tasks', 'Memory', 'Agents', 'Skills', 'Document', 'Code', 'Research', 'Browser', 'Media', 'Policy', 'System', 'Plugins', 'MCP', 'Collaboration', 'General'];

/**
 * 按当前任务对工具做稳定分组排序：相关能力域排到前面，但不删除任何工具。
 * 模型看到的 schema 顺序会显著影响选择；这比“所有工具按插件注册顺序平铺”
 * 更接近按任务路由，同时保留发现全部能力的可能。
 */
export function rankToolsForTask<T extends { name: string }>(tools: T[], query: string | undefined): T[] {
  const q = String(query ?? '').trim();
  if (!q) return tools;
  const scores = new Map<string, number>();
  for (const [domain, re] of Object.entries(DOMAIN_HINTS)) {
    if (re.test(q)) scores.set(domain, 1);
  }
  const rank = (name: string): [number, number, string] => {
    const domain = toolDomain(name);
    const relevant = scores.has(domain);
    const base = BASE_DOMAIN_ORDER.indexOf(domain);
    return [relevant ? 0 : 1, base < 0 ? 99 : base, name];
  };
  return [...tools].sort((a, b) => {
    const [ra, sa, na] = rank(a.name);
    const [rb, sb, nb] = rank(b.name);
    return ra - rb || sa - sb || na.localeCompare(nb);
  });
}
