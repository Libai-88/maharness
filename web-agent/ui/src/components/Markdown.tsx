// ui/src/components/Markdown.tsx —— LLM 输出 Markdown 渲染
import { memo, type ComponentProps } from 'react';
import { Streamdown, defaultComponents } from 'streamdown';
import { streamdownCode } from '@/lib/streamdown-code';
import 'streamdown/styles.css';

function SourceLink({ href, children, node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
  if (!href?.startsWith('#material=')) return <defaultComponents.a {...props} href={href}>{children}</defaultComponents.a>;
  return <a {...props} href={href} onClick={event => { event.preventDefault(); if (location.hash === href) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = href; }}>{children}</a>;
}

export default memo(function Markdown({ text }: { text: string }) {
  return <Streamdown className="text-sm leading-7" components={{ a: SourceLink }} plugins={{ code: streamdownCode }}>{text}</Streamdown>;
});
