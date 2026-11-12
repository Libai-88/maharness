/**
 * core/code-intel/index.ts —— 代码导航最小闭环
 *
 * 提供 repo_map（文件 + 顶层符号）与 find_symbol（按名称查符号）。
 * 当前提取器为轻量正则实现，接口稳定；后续可替换为 tree-sitter/LSP，不改变工具契约。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import type { Plugin, ToolContext } from '../../kernel/types';
import { isDeniedReadPath, resolveInSandbox } from '../../kernel/sandbox';
import { LspClient, pickLspServer, type LspServerConfig } from './lsp';
import { extractSymbolsWithTreeSitter, treeSitterSupported } from './treesitter';

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.h']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', '.dsh', 'vendor', 'coverage', '__pycache__']);
const MAX_FILES = 400;
const MAX_SYMBOLS = 4_000;
const MAX_OUTPUT_CHARS = 24_000;

export interface CodeSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface ProjectDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  code: number;
  message: string;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm },
  { kind: 'enum', re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'const', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/gm },
  { kind: 'python-fn', re: /^\s*(?:async\s+)?def\s+(\w+)/gm },
  { kind: 'python-class', re: /^\s*class\s+(\w+)/gm },
  { kind: 'go-fn', re: /^func\s+(?:\([^)]*\)\s*)?(\w+)/gm },
  { kind: 'go-type', re: /^type\s+(\w+)/gm },
  { kind: 'rust-item', re: /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+(\w+)/gm },
  { kind: 'jvm-type', re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+(\w+)/gm },
];

export function extractSymbols(source: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      const name = match[1];
      if (!name) continue;
      const line = source.slice(0, match.index ?? 0).split('\n').length;
      const key = `${name}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, kind, line });
      if (out.length >= MAX_SYMBOLS) return out;
    }
  }
  return out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/** TS/JS 优先用 TypeScript 编译器 AST；不可用或解析失败时回退正则提取器。 */
export async function extractSymbolsForFile(source: string, file: string): Promise<CodeSymbol[]> {
  if (!/\.[jt]sx?$/i.test(file)) {
    if (treeSitterSupported(file)) {
      const treeSymbols = await extractSymbolsWithTreeSitter(source, file);
      if (treeSymbols.length) return treeSymbols;
    }
    return extractSymbols(source);
  }
  try {
    const ts = await import('typescript');
    const kind = file.toLowerCase().endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    const out: CodeSymbol[] = [];
    const add = (name: string | undefined, symbolKind: string, node: { getStart(sourceFile?: typeof sf): number }) => {
      if (!name) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ name, kind: symbolKind, line });
    };
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement)) add(statement.name?.text, 'function', statement);
      else if (ts.isClassDeclaration(statement)) add(statement.name?.text, 'class', statement);
      else if (ts.isInterfaceDeclaration(statement)) add(statement.name.text, 'interface', statement);
      else if (ts.isTypeAliasDeclaration(statement)) add(statement.name.text, 'type', statement);
      else if (ts.isEnumDeclaration(statement)) add(statement.name.text, 'enum', statement);
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) add(declaration.name.text, 'const', declaration);
        }
      }
    }
    return out.length ? out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)) : extractSymbols(source);
  } catch {
    return extractSymbols(source);
  }
}

function walk(root: string, dir: string, files: string[], limit: number): void {
  if (files.length >= limit) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (files.length >= limit) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, full, files, limit);
      continue;
    }
    if (CODE_EXTS.has(extname(entry.name).toLowerCase())) files.push(full);
  }
}

function repoFiles(tctx: ToolContext, input?: string): { root: string; files: string[] } {
  const root = resolveInSandbox(tctx.sandboxRoot, input ?? '.');
  const files: string[] = [];
  walk(root, root, files, MAX_FILES);
  return { root, files: files.slice(0, MAX_FILES) };
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !!rel && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel);
}

function tsSeverity(category: number, ts: typeof import('typescript')): ProjectDiagnostic['severity'] {
  if (category === ts.DiagnosticCategory.Error) return 'error';
  if (category === ts.DiagnosticCategory.Warning) return 'warning';
  return 'info';
}

/** 用 TypeScript 编译器做项目级诊断；只返回沙箱内文件的诊断，避免把宿主路径带进上下文。 */
export async function collectProjectDiagnostics(
  root: string,
  configInput?: string,
  maxDiagnostics = 100,
): Promise<{ config?: string; files: number; total: number; truncated: boolean; counts: Record<ProjectDiagnostic['severity'], number>; diagnostics: ProjectDiagnostic[] }> {
  const ts = await import('typescript');
  const candidate = resolveInSandbox(root, configInput ?? '.');
  let configFile: string | undefined;
  let rootNames: string[] = [];
  let compilerOptions: import('typescript').CompilerOptions = {
    noEmit: true, skipLibCheck: true, strict: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
    allowJs: true, checkJs: false,
  };

  if (existsSync(candidate)) {
    configFile = statSync(candidate).isDirectory() ? join(candidate, 'tsconfig.json') : candidate;
  }
  if (configFile && existsSync(configFile)) {
    const read = ts.readConfigFile(configFile, ts.sys.readFile);
    if (read.error) {
      const message = ts.flattenDiagnosticMessageText(read.error.messageText, '\n');
      return {
        config: configFile, files: 0, total: 1, truncated: false,
        counts: { error: 1, warning: 0, info: 0 },
        diagnostics: [{ file: relative(root, configFile), line: 1, column: 1, severity: 'error', code: read.error.code, message }],
      };
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configFile), undefined, configFile);
    compilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true };
    rootNames = parsed.fileNames.filter((file) => inside(root, file));
  } else {
    configFile = undefined;
    const files: string[] = [];
    walk(root, root, files, MAX_FILES);
    rootNames = files.filter((file) => /\.(?:ts|tsx|js|jsx|mts|cts)$/i.test(file));
  }
  rootNames = rootNames.slice(0, MAX_FILES);
  if (!rootNames.length) {
    return { config: configFile, files: 0, total: 0, truncated: false, counts: { error: 0, warning: 0, info: 0 }, diagnostics: [] };
  }

  const program = ts.createProgram(rootNames, compilerOptions);
  const all = ts.getPreEmitDiagnostics(program);
  const diagnostics: ProjectDiagnostic[] = [];
  for (const diagnostic of all) {
    if (!diagnostic.file || !inside(root, diagnostic.file.fileName)) continue;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    diagnostics.push({
      file: relative(root, diagnostic.file.fileName).split(sep).join('/'),
      line: position.line + 1,
      column: position.character + 1,
      severity: tsSeverity(diagnostic.category, ts),
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    });
  }
  diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  const counts = diagnostics.reduce(
    (out, item) => { out[item.severity]++; return out; },
    { error: 0, warning: 0, info: 0 } as Record<ProjectDiagnostic['severity'], number>,
  );
  const total = diagnostics.length;
  const limit = Math.max(1, Math.min(200, Math.floor(maxDiagnostics)));
  return {
    config: configFile,
    files: rootNames.length,
    total,
    truncated: total > limit,
    counts,
    diagnostics: diagnostics.slice(0, limit),
  };
}

export default {
  id: 'code-intel',
  name: '代码智能',
  version: '0.1.0',
  onLoad(ctx) {
    const lspConfigs = typeof ctx.config?.get === 'function'
      ? ctx.config.get<Record<string, LspServerConfig>>('codeIntel.lsp', {})
      : {};
    const lspClients = new Map<string, LspClient>();
    const lspClientFor = (file: string, tctx: ToolContext, server?: string): { client: LspClient; root: string } | undefined => {
      const configs = lspConfigs ?? {};
      const picked = server
        ? (configs[server] ? { name: server, cfg: configs[server] } : undefined)
        : pickLspServer(configs, file);
      if (!picked) return undefined;
      const root = tctx.sandboxRoot;
      const key = `${picked.name}:${root}`;
      let client = lspClients.get(key);
      if (!client) {
        client = new LspClient(picked.name, picked.cfg, root);
        lspClients.set(key, client);
      }
      return { client, root };
    };
    if (typeof ctx.effect === 'function') {
      void ctx.effect(() => undefined, () => () => {
        for (const client of lspClients.values()) void client.stop();
        lspClients.clear();
      });
    }
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'code-intel-rules',
        name: '代码导航规则',
        description: '引导在代码任务中先建立 repo map',
        priority: 4,
        content: [
          '代码导航规则：',
          '1. 涉及多文件修改/重构时，先用 repo_map 看目录与顶层符号，再定点读取；',
          '2. 找定义用 find_symbol，找调用/文本用 grep；不要无目的遍历大目录；',
          '3. repo map 只给符号索引，不等于完整实现；修改前仍要 read_file 核对；',
          '4. TypeScript 项目修改后用 project_diagnostics 检查类型错误，再报告完成；',
          '5. 配置了 language server 时，精确跳转/悬停用 lsp_definition / lsp_hover，类型诊断可用 lsp_diagnostics。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'repo_map',
        risk: 'low',
        costHint: 'low',
        timeoutMs: 60_000,
        sideEffect: 'read',
        limits: `最多 ${MAX_FILES} 个代码文件 / ${MAX_SYMBOLS} 个符号 / ${MAX_OUTPUT_CHARS} 字符`,
        output: '{root, files, symbols, truncated, text}',
        outputSchema: {
          type: 'object', required: ['root', 'files', 'symbols', 'truncated', 'text'],
          properties: { root: { type: 'string' }, files: { type: 'integer' }, symbols: { type: 'integer' }, truncated: { type: 'boolean' }, text: { type: 'string' } },
        },
        description: '生成代码仓库地图：列出代码文件与顶层符号（函数/类/接口/类型/常量）。用于重构、导航和多文件任务。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对沙箱根的子目录（默认 .）' },
            maxFiles: { type: 'integer', minimum: 1, maximum: 400 },
          },
        },
        async handler(args: { path?: string; maxFiles?: number }, tctx: ToolContext) {
          const { root, files } = repoFiles(tctx, args.path);
          const limit = Math.max(1, Math.min(MAX_FILES, Math.floor(Number(args.maxFiles) || MAX_FILES)));
          const selected = files.slice(0, limit);
          let symbolCount = 0;
          let truncated = files.length > selected.length;
          const lines: string[] = [];
          for (const file of selected) {
            let source = '';
            try { source = readFileSync(file, 'utf8'); } catch { continue; }
            const symbols = await extractSymbolsForFile(source, file);
            if (!symbols.length) continue;
            const rel = relative(root, file).split(sep).join('/');
            lines.push(`${rel}`);
            for (const symbol of symbols) {
              if (symbolCount >= MAX_SYMBOLS) { truncated = true; break; }
              lines.push(`  ${symbol.line}: ${symbol.name} (${symbol.kind})`);
              symbolCount++;
            }
            if (symbolCount >= MAX_SYMBOLS) { truncated = true; break; }
          }
          let text = lines.join('\n');
          if (text.length > MAX_OUTPUT_CHARS) {
            text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（截断）`;
            truncated = true;
          }
          return { ok: true, data: { root, files: selected.length, symbols: symbolCount, truncated, text } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'find_symbol',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        outputSchema: {
          type: 'object', required: ['count', 'matches'],
          properties: { count: { type: 'integer' }, matches: { type: 'array' } },
        },
        description: '按名称查找代码符号定义（子串匹配，返回文件、行号和类型）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            path: { type: 'string', description: '相对沙箱根的子目录（默认 .）' },
          },
          required: ['name'],
        },
        async handler(args: { name?: string; path?: string }, tctx: ToolContext) {
          const needle = String(args.name ?? '').trim().toLowerCase();
          if (!needle) return { ok: false, error: '缺少 name' };
          const { root, files } = repoFiles(tctx, args.path);
          const matches: { file: string; line: number; name: string; kind: string }[] = [];
          for (const file of files) {
            let source = '';
            try { source = readFileSync(file, 'utf8'); } catch { continue; }
            for (const symbol of await extractSymbolsForFile(source, file)) {
              if (!symbol.name.toLowerCase().includes(needle)) continue;
              matches.push({ file: relative(root, file).split(sep).join('/'), line: symbol.line, name: symbol.name, kind: symbol.kind });
              if (matches.length >= 200) break;
            }
            if (matches.length >= 200) break;
          }
          return { ok: true, data: { count: matches.length, matches } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'project_diagnostics',
        risk: 'low',
        costHint: 'medium',
        timeoutMs: 120_000,
        sideEffect: 'read',
        limits: `默认读取 tsconfig.json；最多 ${MAX_FILES} 个根文件、返回 200 条诊断`,
        output: '{config?, files, total, truncated, counts: {error, warning, info}, diagnostics: [{file, line, column, severity, code, message}]}',
        outputSchema: {
          type: 'object', required: ['files', 'total', 'truncated', 'counts', 'diagnostics'],
          properties: {
            config: { type: 'string' }, files: { type: 'integer' }, total: { type: 'integer' }, truncated: { type: 'boolean' },
            counts: { type: 'object' }, diagnostics: { type: 'array' },
          },
        },
        description: '运行 TypeScript 编译器获取项目级类型诊断。用于修改代码后的验证；只返回沙箱内文件，未找到 tsconfig.json 时扫描项目中的 TS/JS 文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '沙箱内项目目录或 tsconfig.json 路径（默认 .）' },
            maxDiagnostics: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
        async handler(args: { path?: string; maxDiagnostics?: number }, tctx: ToolContext) {
          try {
            const result = await collectProjectDiagnostics(tctx.sandboxRoot, args.path, args.maxDiagnostics);
            return {
              ok: true,
              data: result,
              evidence: [{ kind: 'state', label: `项目诊断：${result.counts.error} error / ${result.counts.warning} warning`, value: result.counts }],
            };
          } catch (err) {
            return { ok: false, error: `项目诊断失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    const lspTarget = (tctx: ToolContext, input?: string, server?: string) => {
      const file = resolveInSandbox(tctx.sandboxRoot, String(input ?? ''));
      if (!existsSync(file)) return { error: `文件不存在: ${input}` };
      if (isDeniedReadPath(file, tctx.sandboxRoot)) return { error: '拒绝读取受保护路径' };
      const picked = lspClientFor(file, tctx, server);
      if (!picked) return { error: '没有匹配的 language server；请在 config.json 配置 codeIntel.lsp' };
      return { file, ...picked };
    };

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'lsp_definition',
        risk: 'low',
        costHint: 'low',
        timeoutMs: 60_000,
        sideEffect: 'read',
        output: '{definitions: [{file, line, character}], count}',
        outputSchema: {
          type: 'object', required: ['count', 'definitions'],
          properties: { count: { type: 'integer' }, definitions: { type: 'array' } },
        },
        description: '通过已配置的 language server 查找符号定义（精确跳转，优于文本搜索）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '沙箱内文件路径' },
            line: { type: 'integer', minimum: 1, description: '1-based 行号' },
            character: { type: 'integer', minimum: 1, description: '1-based 列号' },
            server: { type: 'string', description: '可选：指定 codeIntel.lsp 中的 server 名' },
          },
          required: ['path', 'line', 'character'],
        },
        async handler(args: { path?: string; line?: number; character?: number; server?: string }, tctx: ToolContext) {
          const target = lspTarget(tctx, args.path, args.server);
          if ('error' in target) return { ok: false, error: target.error };
          try {
            const locations = await target.client.definition(target.file, Math.max(0, Number(args.line) - 1), Math.max(0, Number(args.character) - 1));
            const definitions = locations.map((loc) => ({
              file: relative(target.root, target.client.pathOf(loc.uri)).split(sep).join('/'),
              line: loc.range.start.line + 1,
              character: loc.range.start.character + 1,
            })).filter((loc) => !loc.file.startsWith('..'));
            return { ok: true, data: { count: definitions.length, definitions } };
          } catch (err) {
            return { ok: false, error: `LSP definition 失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'lsp_hover',
        risk: 'low',
        costHint: 'low',
        timeoutMs: 60_000,
        sideEffect: 'read',
        output: '{text, truncated}',
        outputSchema: {
          type: 'object', required: ['text', 'truncated'],
          properties: { text: { type: 'string' }, truncated: { type: 'boolean' } },
        },
        description: '通过 language server 获取光标位置的类型/文档悬停信息。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            line: { type: 'integer', minimum: 1 },
            character: { type: 'integer', minimum: 1 },
            server: { type: 'string' },
          },
          required: ['path', 'line', 'character'],
        },
        async handler(args: { path?: string; line?: number; character?: number; server?: string }, tctx: ToolContext) {
          const target = lspTarget(tctx, args.path, args.server);
          if ('error' in target) return { ok: false, error: target.error };
          try {
            const text = await target.client.hover(target.file, Math.max(0, Number(args.line) - 1), Math.max(0, Number(args.character) - 1));
            return { ok: true, data: { text: text.slice(0, 8_000), truncated: text.length > 8_000 } };
          } catch (err) {
            return { ok: false, error: `LSP hover 失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'lsp_diagnostics',
        risk: 'low',
        costHint: 'medium',
        timeoutMs: 60_000,
        sideEffect: 'read',
        output: '{file, diagnostics: [{line, character, severity, message}], count}',
        outputSchema: {
          type: 'object', required: ['file', 'count', 'diagnostics'],
          properties: { file: { type: 'string' }, count: { type: 'integer' }, diagnostics: { type: 'array' } },
        },
        description: '读取 language server 对单个文件发布的诊断（需要 server 支持 publishDiagnostics）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            server: { type: 'string' },
          },
          required: ['path'],
        },
        async handler(args: { path?: string; server?: string }, tctx: ToolContext) {
          const target = lspTarget(tctx, args.path, args.server);
          if ('error' in target) return { ok: false, error: target.error };
          try {
            const raw = await target.client.diagnostics(target.file);
            const severity = ['unknown', 'error', 'warning', 'info', 'hint'] as const;
            const diagnostics = raw.map((item) => ({
              line: item.range.start.line + 1,
              character: item.range.start.character + 1,
              severity: severity[Math.max(0, Math.min(4, Number(item.severity) || 0))],
              message: item.message,
            }));
            return { ok: true, data: { file: relative(target.root, target.file).split(sep).join('/'), count: diagnostics.length, diagnostics } };
          } catch (err) {
            return { ok: false, error: `LSP diagnostics 失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.logger.info('代码智能就绪: repo_map / find_symbol / project_diagnostics / lsp_definition / lsp_hover / lsp_diagnostics');
  },
} satisfies Plugin;
