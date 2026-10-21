import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { appRuntimePlugin } from './vite/app-runtime'

export default defineConfig({
  plugins: [react(), tailwindcss(), appRuntimePlugin()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Monaco's workers import modules dynamically, which needs module workers.
  worker: { format: 'es' },
  server: {
    port: 5173,
    // `ws`: the editors' documents (M16) are WebSockets under /api/collab.
    proxy: { '/api': { target: 'http://localhost:3000', ws: true } },
  },
})
