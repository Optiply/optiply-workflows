import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Monaco's workers import modules dynamically, which needs module workers.
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
})
