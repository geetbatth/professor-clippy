// Browser-only preview of the renderer on the mock backend: `npm run dev:renderer -w apps/desktop`,
// then open http://localhost:5174/ (add ?mode=expanded, ?tab=chat, or ?gallery=1&zoom=3).
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5174, strictPort: false },
});
