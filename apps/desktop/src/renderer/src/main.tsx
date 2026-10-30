import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { preloadSprites } from './clippy/sprites';
import { Gallery } from './dev/Gallery';
import { resolveRuntime } from './runtime';
import { themeFromSearch } from './theme';
import { BackendMissing } from './views/BackendMissing';
import { PageWindow } from './views/PageWindow';
import './styles/theme.css';
import './styles/global.css';
import './styles/controls.css';

// Fetch and decode every Clippy pose up front, so swapping poses never flickers.
void preloadSprites();

// A page window is told the theme to paint (`?theme=`): paint it before the first render, so a
// dark theme never flashes classic yellow while settings load. `useTheme` takes over from there.
const initialTheme = themeFromSearch(location.search);
if (initialTheme) {
  document.documentElement.dataset.theme = initialTheme.theme;
  document.documentElement.dataset.dark = initialTheme.dark;
}

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
