import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Gallery } from './dev/Gallery';
import { resolveRuntime } from './runtime';
import './styles/global.css';
import './styles/controls.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// `?gallery=1` is the dev character sheet; everything else is the real UI.
const page = new URLSearchParams(location.search).has('gallery') ? <Gallery /> : <App runtime={resolveRuntime()} />;
createRoot(root).render(<StrictMode>{page}</StrictMode>);
