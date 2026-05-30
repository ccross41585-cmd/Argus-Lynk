import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['app-icon.svg', 'app-icon-maskable.svg', 'argus-lynk-logo.png'],
      manifest: {
        name: 'Argus Lynk Home Base',
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
    }),
  ],
})
