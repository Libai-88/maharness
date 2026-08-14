// ui/src/components/Markdown.tsx —— LLM 输出 Markdown 渲染（安全 + 代码高亮）
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';

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
