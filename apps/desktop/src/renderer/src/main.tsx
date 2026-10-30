import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Gallery } from './dev/Gallery';
import { resolveRuntime } from './runtime';
import { BackendMissing } from './views/BackendMissing';
import './styles/global.css';
import './styles/controls.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

function page(): ReactNode {
  // `?gallery=1` is the dev character sheet; everything else is the real UI.
  if (new URLSearchParams(location.search).has('gallery')) return <Gallery />;
  const runtime = resolveRuntime();
  return runtime ? <App runtime={runtime} /> : <BackendMissing />;
}

createRoot(root).render(<StrictMode>{page()}</StrictMode>);
