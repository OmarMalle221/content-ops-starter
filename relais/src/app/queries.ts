import { useQuery } from '@tanstack/react-query';
import { EMERGENCY_SNAPSHOT, getProfile, listHelpResources, listMyConsents, type Resource } from '../lib/api';
import { logEvent } from '../lib/log';
import { useSession } from './session';

export const queryKeys = {
    profile: (userId: string | undefined) => ['profile', userId] as const,
    consents: (userId: string | undefined) => ['consents', userId] as const,
    helpResources: ['resources', 'help'] as const
};

export function useProfile() {
    const { session } = useSession();
    const userId = session?.user.id;
    return useQuery({
        queryKey: queryKeys.profile(userId),
        queryFn: () => getProfile(userId as string),
        enabled: Boolean(userId)
    });
}

export function useMyConsents() {
    const { session } = useSession();
    const userId = session?.user.id;
    return useQuery({
        queryKey: queryKeys.consents(userId),
        queryFn: listMyConsents,
        enabled: Boolean(userId)
    });
}

/**
 * Ressources d'aide lues dans la table `resources`. Tant qu'elles ne sont pas chargées, ou si le réseau
 * échoue, la copie de secours (même source) s'affiche : l'écran d'urgence ne reste jamais vide.
 */
export function useHelpResources(): Resource[] {
    const query = useQuery({
        queryKey: queryKeys.helpResources,
        queryFn: async () => {
            try {
                return await listHelpResources();
            } catch (error) {
                logEvent('resources_fallback_used');
                throw error;
            }
        },
        staleTime: 60 * 60 * 1000,
        retry: 1
    });
    return query.data ?? EMERGENCY_SNAPSHOT;
}
