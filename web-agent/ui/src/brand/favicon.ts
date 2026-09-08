/**
 * ui/src/brand/favicon.ts —— 随主题翻转的 favicon（与侧栏/头像/大图共用同一 path 源）
 * 颜色取自当前生效的 CSS token，主题切换时重写 <link rel="icon">：
 * 此前的内联 favicon 把 #e0512f/#fff8ec 写死，浅色主题下会「一块橙斑」看不清。
 */
import { sheepSvg, SHEEP_MARK } from './sheep';

function token(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function applyFavicon(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  const tile = theme === 'light' ? token('--accent', '#ff6a45') : token('--bg-panel', '#221f1e');
  const ink = theme === 'light' ? '#fff8ec' : token('--accent', '#ff6a45');
  const svg = sheepSvg({ fg: ink, bg: tile, parts: SHEEP_MARK });
  const href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = href;
}
