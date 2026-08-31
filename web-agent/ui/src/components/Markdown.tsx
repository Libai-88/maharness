// ui/src/components/Markdown.tsx —— LLM 输出 Markdown 渲染（安全 + 代码高亮）
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
// 按需注册常用语言子集（全量 highlight.js ≈1MB；core + 15 语言 ≈几十 kB）
import hljs from 'highlight.js/lib/core';
import 'highlight.js/styles/github.css';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
for (const [name, lang] of Object.entries({
  javascript, typescript, json, css, xml, bash, python, sql, markdown, yaml, java, go, rust, c, cpp,
})) hljs.registerLanguage(name, lang);

// GFM（表格/删除线/任务列表）+ 代码高亮
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : '';
      const highlighted = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
      return `<pre class="hljs"><code${language ? ` class="language-${language}"` : ''}>${highlighted}</code></pre>`;
    },
  },
});

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text) as string;
    // LLM 输出为不可信输入：先清洗再注入
    return DOMPurify.sanitize(raw);
  }, [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
