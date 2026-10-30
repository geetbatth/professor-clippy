import { useEffect, type ReactNode } from 'react';
import { WINDOW_SIZES, type WindowMode } from '../../../main/window/windowApi';

/**
 * Plain-browser preview only (`npm run dev:renderer`): a pretend desktop with the
 * window-sized frame parked in the bottom-right corner, like the real window.
 */
export function BrowserFrame({ mode, children }: { mode: WindowMode; children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add('mock-desk');
    return () => document.body.classList.remove('mock-desk');
  }, []);
  const { width, height } = WINDOW_SIZES[mode];
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, width, height, outline: '1px dashed rgba(255,255,255,0.25)' }}>
      {children}
    </div>
  );
}
