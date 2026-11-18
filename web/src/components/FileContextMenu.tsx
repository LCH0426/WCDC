import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  dividerBefore?: boolean;
}

export function FileContextMenu({
  open,
  x,
  y,
  items,
  onSelect,
  onClose,
}: {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onViewportChange = () => onClose();
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const width = 216;
  const height = items.filter((item) => !item.disabled).length * 38 + 24;
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));

  return createPortal(
    <div
      ref={menuRef}
      role='menu'
      className='fixed z-[200] w-[216px] rounded-2xl border border-white/70 bg-content1/95 p-1.5 shadow-2xl shadow-slate-900/15 backdrop-blur-xl dark:border-white/[0.08]'
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type='button'
          role='menuitem'
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            onSelect(item.key);
            onClose();
          }}
          className={clsx(
            'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition',
            item.dividerBefore && 'mt-1 border-t border-slate-200/60 pt-2.5 dark:border-white/[0.07]',
            item.danger
              ? 'text-danger hover:bg-danger/10'
              : 'text-slate-700 hover:bg-primary/10 hover:text-primary dark:text-slate-200',
            item.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-inherit'
          )}
        >
          <span className='flex h-4 w-4 shrink-0 items-center justify-center'>
            {item.icon}
          </span>
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
