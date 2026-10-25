import { useQuery } from '@tanstack/react-query';
import { listAppointments, listJournal, listQuestions, listTasks } from '../../lib/coordination';
import { coordination as tc } from '../../i18n/coordination.fr';
import type { Membership } from '../../lib/careFiles';

export const coordKeys = {
    tasks: (fileId: string) => ['file', fileId, 'tasks'] as const,
    appointments: (fileId: string) => ['file', fileId, 'appointments'] as const,
    questions: (appointmentId: string) => ['appointment', appointmentId, 'questions'] as const,
    journal: (fileId: string) => ['file', fileId, 'journal'] as const
};

export const useTasks = (fileId: string) => useQuery({ queryKey: coordKeys.tasks(fileId), queryFn: () => listTasks(fileId) });
export const useAppointments = (fileId: string) =>
    useQuery({ queryKey: coordKeys.appointments(fileId), queryFn: () => listAppointments(fileId) });
export const useQuestions = (appointmentId: string, enabled: boolean) =>
    useQuery({ queryKey: coordKeys.questions(appointmentId), queryFn: () => listQuestions(appointmentId), enabled });
export const useJournal = (fileId: string, enabled: boolean) =>
    useQuery({ queryKey: coordKeys.journal(fileId), queryFn: () => listJournal(fileId), enabled });

type Member = Membership & { display_name: string | null };

/** Nom affiché d'un membre ; « (vous) » pour soi-même. */
export function memberName(members: Member[] | undefined, userId: string | null, myId: string | undefined): string | null {
    if (!userId) return null;
    const member = members?.find((m) => m.user_id === userId);
    const name = member?.display_name ?? tc.someone;
    return userId === myId ? tc.me(name) : name;
}

/** Choix « qui s'en occupe » ou « qui accompagne » (la personne aidée ne s'accompagne pas elle-même). */
export function memberOptions(members: Member[] | undefined, myId: string | undefined, companion = false) {
    return [
        { value: '', label: tc.nobody },
        ...(members ?? [])
            .filter((m) => !companion || m.role !== 'care_recipient')
            .map((m) => ({ value: m.user_id, label: memberName(members, m.user_id, myId) ?? tc.someone }))
    ];
}
