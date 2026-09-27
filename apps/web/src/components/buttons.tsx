import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import type { IconProps } from './icons';

type ButtonBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

/** Compact bordered button: the app's one button style (mobile `QuietButton`). */
export const QuietButton = forwardRef<
  HTMLButtonElement,
  ButtonBase & { label: ReactNode; emphasis?: boolean; icon?: ComponentType<IconProps>; expand?: boolean; tone?: 'danger' }
>(function QuietButton({ label, emphasis, icon: Icon, expand, tone, className, type = 'button', ...rest }, ref) {
  const cls = ['quiet-button', emphasis && 'is-emphasis', expand && 'is-expand', tone === 'danger' && 'is-danger', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {Icon && <Icon size={16} />}
      <span>{label}</span>
    </button>
  );
});

/**
 * Icon-only control with a 44px hit area, an accessible label and a hover
 * tooltip on pointer devices (mobile `QuietIconButton`).
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonBase & {
    icon: ComponentType<IconProps>;
    label: string;
    tone?: 'muted' | 'danger';
    tooltipSide?: 'top' | 'bottom' | 'left' | 'none';
    size?: number;
    /** Keyboard shortcut shown in the tooltip, e.g. "T". */
    shortcut?: string;
  }
>(function IconButton({ icon: Icon, label, tone, tooltipSide = 'bottom', size = 20, shortcut, className, type = 'button', ...rest }, ref) {
  const cls = ['icon-button', tone && `is-${tone}`, className].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      aria-label={label}
      data-tooltip={tooltipSide === 'none' ? undefined : shortcut ? `${label} · ${shortcut}` : label}
      aria-keyshortcuts={shortcut}
      data-tooltip-side={tooltipSide}
      {...rest}
    >
      <Icon size={size} />
    </button>
  );
});
