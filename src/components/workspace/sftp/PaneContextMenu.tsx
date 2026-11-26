import React, { useEffect, useRef } from 'react';
import { useMenuPosition } from '../../../utils/useMenuPosition';

// =================================================================================================
// Context menu of a pane
// =================================================================================================

export const PaneContextMenu: React.FC<{ x: number; y: number; onClose: () => void; children: React.ReactNode }> = ({
  x,
  y,
  onClose,
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const menuStyle = useMenuPosition(ref, { x, y });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // close only the menu, not the whole SFTP window
        onClose();
      }
    };
    const onScroll = () => onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onScroll, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onClose}
      style={menuStyle}
      className="fixed z-[75] min-w-52 rounded-lg border border-slate-700 bg-slate-900/95 py-1 text-xs text-slate-200 shadow-xl shadow-black/50 backdrop-blur-md"
    >
      {children}
    </div>
  );
};

export const MenuItem: React.FC<{
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ icon, onClick, disabled, danger, children }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
      danger ? 'hover:bg-red-500/20 hover:text-red-300' : 'hover:bg-slate-800'
    }`}
  >
    <span className="flex w-3.5 shrink-0 justify-center">{icon}</span>
    <span className="truncate">{children}</span>
  </button>
);
