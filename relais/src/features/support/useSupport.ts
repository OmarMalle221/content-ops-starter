import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../app/session';
import {
    getPilotMetrics,
    listMyCheckins,
    listMyFeedback,
    listMySupportRequests,
    listSupportNotes,
    listSupportRequests
} from '../../lib/support';

export const supportKeys = {
    checkins: (userId: string | undefined) => ['checkins', userId] as const,
    myRequests: (userId: string | undefined) => ['support', 'mine', userId] as const,
    board: ['support', 'board'] as const,
    notes: (requestId: string) => ['support', requestId, 'notes'] as const,
    feedback: (userId: string | undefined) => ['pilot-feedback', userId] as const,
    metrics: ['pilot-metrics'] as const
};

export function useMyCheckins(enabled: boolean) {
    const { session } = useSession();
    return useQuery({ queryKey: supportKeys.checkins(session?.user.id), queryFn: listMyCheckins, enabled: enabled && Boolean(session) });
}

export function useMySupportRequests() {
    const { session } = useSession();
    const userId = session?.user.id;
    return useQuery({
        queryKey: supportKeys.myRequests(userId),
        queryFn: () => listMySupportRequests(userId as string),
        enabled: Boolean(userId)
    });
}

export const useSupportBoard = (enabled: boolean) => useQuery({ queryKey: supportKeys.board, queryFn: listSupportRequests, enabled });
export const useSupportNotes = (requestId: string, enabled: boolean) =>
    useQuery({ queryKey: supportKeys.notes(requestId), queryFn: () => listSupportNotes(requestId), enabled });

export function useMyFeedback(enabled: boolean) {
    const { session } = useSession();
    return useQuery({ queryKey: supportKeys.feedback(session?.user.id), queryFn: listMyFeedback, enabled: enabled && Boolean(session) });
}

export const usePilotMetrics = (enabled: boolean) => useQuery({ queryKey: supportKeys.metrics, queryFn: getPilotMetrics, enabled });
