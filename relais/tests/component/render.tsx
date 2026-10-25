import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../../src/app/router';
import { SessionProvider } from '../../src/app/session';
import { DistressProvider } from '../../src/features/distress/DistressProvider';

function client() {
    return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

/** Rend un composant isolé avec les fournisseurs de l'application (requêtes, session, détresse). */
export function renderWithProviders(ui: ReactNode) {
    return render(
        <QueryClientProvider client={client()}>
            <SessionProvider>
                <DistressProvider>{ui}</DistressProvider>
            </SessionProvider>
        </QueryClientProvider>
    );
}

/** Rend l'application complète à une adresse donnée. */
export function renderApp(path: string) {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    const view = renderWithProviders(<RouterProvider router={router} />);
    return { ...view, router };
}
