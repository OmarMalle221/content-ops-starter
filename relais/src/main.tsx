import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { createRouter } from './app/router';
import { SessionProvider } from './app/session';
import { DistressProvider } from './features/distress/DistressProvider';
import { errorFields, logEvent } from './lib/log';
import './styles.css';

// Erreurs non interceptées : nom et code seulement, jamais le message (il peut contenir une saisie).
window.addEventListener('error', (event) => logEvent('unhandled_error', errorFields(event.error)));
window.addEventListener('unhandledrejection', (event) => logEvent('unhandled_error', errorFields(event.reason)));

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 }
    }
});
const router = createRouter();

const root = document.getElementById('root');
if (!root) throw new Error('Élément #root introuvable');

createRoot(root).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <SessionProvider>
                <DistressProvider>
                    <RouterProvider router={router} />
                </DistressProvider>
            </SessionProvider>
        </QueryClientProvider>
    </StrictMode>
);
logEvent('app_started');
