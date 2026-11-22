import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

describe('Button', () => {
  it('渲染可访问的按钮并合并自定义 className', () => {
    render(
      <Button variant="outline" size="sm" className="extra-class">
        发送
      </Button>,
    );
    const button = screen.getByRole('button', { name: '发送' });
    expect(button.getAttribute('data-slot')).toBe('button');
    expect(button.className).toContain('extra-class');
  });

  it('disabled 时不可点击', () => {
    render(<Button disabled>提交</Button>);
    expect((screen.getByRole('button', { name: '提交' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Badge', () => {
  it('按 variant 标记并可携带自定义内容', () => {
    render(<Badge variant="destructive">失败</Badge>);
    const badge = screen.getByText('失败');
    expect(badge.getAttribute('data-slot')).toBe('badge');
    expect(badge.className).toContain('bg-destructive');
  });
});
