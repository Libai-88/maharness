/**
 * ui/src/brand/favicon.ts —— 品牌 favicon
 * logo 已有固定奶油/棕色/薄荷配色，不再按主题重新绘制，避免品牌标记漂移。
 */
export function applyFavicon(): void {
  if (typeof document === 'undefined') return;
  const href = '/brand/favicon-32.png';
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';
  link.href = href;
}
