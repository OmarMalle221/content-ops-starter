import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { securityHeaders } from './security-headers.ts';

export default defineConfig(({ mode }) => ({
    plugins: [
        react(),
        tailwindcss(),
        VitePWA({
            registerType: 'autoUpdate',
            // Fichier registerSW.js séparé : compatible avec une politique CSP sans script en ligne.
            injectRegister: 'script',
            includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
            manifest: {
                name: 'Relais',
                short_name: 'Relais',
                description: 'Coordonner les soins d’un parent et obtenir les aides auxquelles il a droit.',
                lang: 'fr-CA',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                background_color: '#f5f8f7',
                theme_color: '#0f5257',
                icons: [
                    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
                    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
                ]
            },
            workbox: {
                // Seulement l'application : aucune donnée du dossier n'est mise en cache sur le téléphone.
                globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
                navigateFallback: '/index.html',
                runtimeCaching: []
            }
        })
    ],
    server: { port: 5173 },
    // La prévisualisation applique les mêmes en-têtes que Netlify : les tests e2e tournent sous la CSP.
    preview: {
        port: 4173,
        headers: securityHeaders(new URL(loadEnv(mode, process.cwd()).VITE_SUPABASE_URL ?? 'http://127.0.0.1:54399').origin)
    },
    build: { sourcemap: false },
    test: {
        projects: [
            {
                extends: true,
                test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' }
            },
            {
                extends: true,
                test: {
                    name: 'component',
                    include: ['tests/component/**/*.test.tsx'],
                    environment: 'jsdom',
                    setupFiles: ['tests/component/setup.ts']
                }
            }
        ]
    }
}));
