import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest lets us use a custom service worker (src/sw.ts) that
      // handles both Workbox precaching AND push notification events.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['app-icon.svg', 'app-icon-maskable.svg', 'argus-lynk-logo.png'],
      manifest: {
        name: 'Argus Lynk',
        short_name: 'Argus Lynk',
        description: 'Tablet-first home base dashboard for ESP32 LoRa field devices and gateway routing.',
        theme_color: '#182321',
        background_color: '#101816',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'app-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'app-icon-maskable.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      // Ensure the SW is compiled from TypeScript properly
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
      },
    }),
  ],
})
