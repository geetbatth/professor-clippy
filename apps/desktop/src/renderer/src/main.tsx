import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { preloadSprites } from './clippy/sprites';
import { Gallery } from './dev/Gallery';
import { resolveRuntime } from './runtime';
import { BackendMissing } from './views/BackendMissing';
import { PageWindow } from './views/PageWindow';
import './styles/theme.css';
import './styles/global.css';
import './styles/controls.css';

// Fetch and decode every Clippy pose up front, so swapping poses never flickers.
void preloadSprites();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

function page(): ReactNode {
  const params = new URLSearchParams(location.search);
  // `?gallery=1` is the dev character sheet; everything else is the real UI.
  if (params.has('gallery')) return <Gallery />;
  const runtime = resolveRuntime();
  if (!runtime) return <BackendMissing />;
  // `?page=<id>`: a Pad page popped out onto the desktop (`?mock=1&page=<id>` previews one).
  const pageId = params.get('page');
  return pageId ? <PageWindow runtime={runtime} id={pageId} /> : <App runtime={runtime} />;
}

createRoot(root).render(<StrictMode>{page()}</StrictMode>);
