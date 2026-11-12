// ui/src/components/Markdown.tsx —— LLM 输出 Markdown 渲染
import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { streamdownCode } from '@/lib/streamdown-code';
import 'streamdown/styles.css';

export default memo(function Markdown({ text }: { text: string }) {
  return <Streamdown className="text-sm leading-7" plugins={{ code: streamdownCode }}>{text}</Streamdown>;
});
