import type { CodeHighlighterPlugin, HighlightOptions, HighlightResult } from 'streamdown';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const LANGUAGES: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'bash',
  shell: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  'c++': 'cpp',
  'c#': 'csharp',
  ps1: 'powershell',
};

const THEMES = ['github-light', 'github-dark'] as const;
const cache = new Map<string, HighlightResult>();
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterPromise;
}

function resolveLanguage(language: string) {
  const key = language.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

export const streamdownCode: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getSupportedLanguages: () => [...Object.keys(LANGUAGES), 'text'],
  getThemes: () => [...THEMES],
  supportsLanguage: (language) => {
    const key = resolveLanguage(language);
    return key === 'text' || key === 'plaintext' || key in LANGUAGES;
  },
  highlight({ code, language, themes, isIncomplete }: HighlightOptions, callback?: (result: HighlightResult) => void) {
    const key = `${resolveLanguage(language)}\0${themes[0]}\0${themes[1]}\0${code}`;
    const cached = cache.get(key);
    if (cached) return cached;

    void getHighlighter()
      .then(async (highlighter) => {
        const requested = resolveLanguage(language);
        const hasLanguage = requested in LANGUAGES;
        if (hasLanguage && !highlighter.getLoadedLanguages().includes(requested)) {
          await highlighter.loadLanguage(LANGUAGES[requested]() as never);
        }
        const result = highlighter.codeToTokens(code, {
          lang: hasLanguage && highlighter.getLoadedLanguages().includes(requested) ? requested : 'text',
          themes: { light: themes[0] as never, dark: themes[1] as never },
        });
        if (!isIncomplete) cache.set(key, result);
        callback?.(result);
      })
      .catch(() => undefined);

    return null;
  },
};
