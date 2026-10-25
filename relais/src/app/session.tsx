import type { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';

interface SessionState {
    session: Session | null;
    loading: boolean;
}

const SessionContext = createContext<SessionState>({ session: null, loading: true });

export function SessionProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<SessionState>({ session: null, loading: true });
    const queryClient = useQueryClient();

    useEffect(() => {
        const client = supabase();
        let active = true;
        void client.auth.getSession().then(({ data }) => {
            if (active) setState({ session: data.session, loading: false });
        });
        const { data } = client.auth.onAuthStateChange((event, session) => {
            setState({ session, loading: false });
            // Rien du compte précédent ne reste en mémoire après une déconnexion.
            if (event === 'SIGNED_OUT') queryClient.clear();
        });
        return () => {
            active = false;
            data.subscription.unsubscribe();
        };
    }, [queryClient]);

    return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
    return useContext(SessionContext);
}

/** Niveau d'assurance de la session (« aal1 » ou « aal2 »), lu dans le jeton d'accès. */
export function sessionAal(session: Session | null): 'aal1' | 'aal2' | null {
    if (!session) return null;
    try {
        const payload = session.access_token.split('.')[1] ?? '';
        const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        const aal = (JSON.parse(json) as { aal?: unknown }).aal;
        return aal === 'aal2' ? 'aal2' : 'aal1';
    } catch {
        return 'aal1';
    }
}
