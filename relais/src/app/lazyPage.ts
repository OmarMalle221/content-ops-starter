import { lazy, type ComponentType } from 'react';

/** Page chargée à la demande (un fichier par page), affichée sous le <Suspense> de la mise en page. */
export function lazyPage<M extends Record<string, unknown>>(loader: () => Promise<M>, name: keyof M) {
    return lazy(async () => ({ default: (await loader())[name] as ComponentType }));
}
