import { cn } from '@/lib/utils';

export const BRAND_MARK_SRC = '/brand/maharness-mark-192.png';
export const BRAND_LOGO_SRC = '/brand/maharness-logo-ui.png';

export default function BrandMark({
  size = 20,
  className,
  alt = '',
}: {
  size?: number;
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={BRAND_MARK_SRC}
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      draggable={false}
      className={cn('shrink-0 select-none object-contain', className)}
    />
  );
}
