/**
 * Tree-sitter 多语言符号索引（WASM，无原生编译）。
 * 只做顶层符号提取；TS/JS 仍优先走 TypeScript AST（语义更准）。
 */
import Parser from 'web-tree-sitter';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import type { CodeSymbol } from './index';

const GRAMMAR_DIR = fileURLToPath(new URL('../../node_modules/tree-sitter-wasms/out/', import.meta.url));
const GRAMMARS: Record<string, string> = {
  '.py': 'tree-sitter-python.wasm',
  '.go': 'tree-sitter-go.wasm',
  '.rs': 'tree-sitter-rust.wasm',
  '.java': 'tree-sitter-java.wasm',
  '.cs': 'tree-sitter-c_sharp.wasm',
  '.c': 'tree-sitter-c.wasm',
  '.h': 'tree-sitter-c.wasm',
  '.cpp': 'tree-sitter-cpp.wasm',
  '.cc': 'tree-sitter-cpp.wasm',
  '.cxx': 'tree-sitter-cpp.wasm',
  '.ts': 'tree-sitter-typescript.wasm',
  '.tsx': 'tree-sitter-tsx.wasm',
  '.js': 'tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-javascript.wasm',
  '.rb': 'tree-sitter-ruby.wasm',
  '.php': 'tree-sitter-php.wasm',
  '.lua': 'tree-sitter-lua.wasm',
  '.kt': 'tree-sitter-kotlin.wasm',
};

const KINDS: Record<string, string> = {
  function_definition: 'function',
  function_declaration: 'function',
  method_definition: 'method',
  method_declaration: 'method',
  constructor_declaration: 'constructor',
  class_definition: 'class',
  class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  type_spec: 'type',
  enum_declaration: 'enum',
  enum_specifier: 'enum',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  function_item: 'function',
};

let parserPromise: Promise<Parser> | null = null;
const languages = new Map<string, Parser.Language>();
const warned = new Set<string>();

async function parser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      return new Parser();
    })();
  }
  return parserPromise;
}

async function languageFor(file: string): Promise<Parser.Language | null> {
  const ext = extname(file).toLowerCase();
  const grammar = GRAMMARS[ext];
  if (!grammar) return null;
  let language = languages.get(grammar);
  if (!language) {
    try {
      await parser();
      language = await Parser.Language.load(`${GRAMMAR_DIR}${grammar}`);
      languages.set(grammar, language);
    } catch (err) {
      if (!warned.has(grammar)) {
        warned.add(grammar);
        console.warn(`[code-intel] tree-sitter grammar 加载失败 ${grammar}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }
  return language;
}

function nameOf(node: Record<string, unknown>): string | undefined {
  const field = (name: string): string | undefined => {
    const child = typeof node.childForFieldName === 'function'
      ? (node.childForFieldName as (field: string) => { text?: string } | null)(name)
      : null;
    return child?.text;
  };
  const direct = field('name');
  if (direct) return direct;
  const declarator = field('declarator');
  if (declarator) return declarator;
  const text = String(node.text ?? '');
  return text.match(/\b([A-Za-z_][\w]*)\s*[(:<]/)?.[1];
}

function walk(node: Record<string, unknown>, out: CodeSymbol[], limit: number): void {
  if (out.length >= limit) return;
  const type = String(node.type ?? '');
  const kind = KINDS[type];
  if (kind) {
    const name = nameOf(node);
    if (name) {
      const start = node.startPosition as { row?: number } | undefined;
      out.push({ name, kind, line: (start?.row ?? 0) + 1 });
    }
  }
  const children = Array.isArray(node.namedChildren) ? node.namedChildren as Record<string, unknown>[] : [];
  for (const child of children) walk(child, out, limit);
}

export async function extractSymbolsWithTreeSitter(source: string, file: string, limit = 4_000): Promise<CodeSymbol[]> {
  const language = await languageFor(file);
  if (!language) return [];
  const p = await parser();
  try {
    p.setLanguage(language);
    const tree = p.parse(source);
    if (!tree) return [];
    const out: CodeSymbol[] = [];
    walk(tree.rootNode as unknown as Record<string, unknown>, out, limit);
    return out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function treeSitterSupported(file: string): boolean {
  return !!GRAMMARS[extname(file).toLowerCase()];
}
