import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Local dev has no Vercel functions. Set VITE_API_PROXY to a deployed
    // origin (e.g. https://app.ankorahq.com) to test /api/* against it.
    proxy: process.env.VITE_API_PROXY ? {
      '/api': { target: process.env.VITE_API_PROXY, changeOrigin: true },
    } : undefined,
  },
})
