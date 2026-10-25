import { useQuery } from '@tanstack/react-query';
import { useMyConsents } from '../../app/queries';
import { useSession } from '../../app/session';
import {
    getCareFile,
    getCareNeeds,
    getCareRecipient,
    listAccessLog,
    listCareFiles,
    listContacts,
    listFileConsents,
    listInvitations,
    listMembers,
    listMyMemberships,
    type AccessLevel,
    type FileConsent
} from '../../lib/careFiles';
import { activeConsent } from '../../lib/consents';

export const fileKeys = {
    myFiles: (userId: string | undefined) => ['my-files', userId] as const,
    file: (id: string) => ['file', id] as const,
    members: (id: string) => ['file', id, 'members'] as const,
    invitations: (id: string) => ['file', id, 'invitations'] as const,
    consents: (id: string) => ['file', id, 'consents'] as const,
    recipient: (id: string) => ['file', id, 'recipient'] as const,
    needs: (id: string) => ['file', id, 'needs'] as const,
    contacts: (id: string) => ['file', id, 'contacts'] as const,
    log: (id: string) => ['file', id, 'log'] as const
};

export function useMyFiles() {
    const { session } = useSession();
    const userId = session?.user.id;
    return useQuery({
        queryKey: fileKeys.myFiles(userId),
        enabled: Boolean(userId),
        queryFn: async () => {
            const memberships = await listMyMemberships(userId as string);
            const files = await listCareFiles(memberships.map((m) => m.care_file_id));
            return memberships
                .map((m) => ({ membership: m, file: files.find((f) => f.id === m.care_file_id) }))
                .filter((entry): entry is { membership: typeof entry.membership; file: NonNullable<typeof entry.file> } =>
                    Boolean(entry.file)
                );
        }
    });
}

export const useCareFile = (id: string) => useQuery({ queryKey: fileKeys.file(id), queryFn: () => getCareFile(id) });
export const useMembers = (id: string) => useQuery({ queryKey: fileKeys.members(id), queryFn: () => listMembers(id) });
export const useInvitations = (id: string, enabled: boolean) =>
    useQuery({ queryKey: fileKeys.invitations(id), queryFn: () => listInvitations(id), enabled });
export const useFileConsents = (id: string) => useQuery({ queryKey: fileKeys.consents(id), queryFn: () => listFileConsents(id) });
export const useCareRecipient = (id: string) => useQuery({ queryKey: fileKeys.recipient(id), queryFn: () => getCareRecipient(id) });
export const useCareNeeds = (id: string, enabled: boolean) =>
    useQuery({ queryKey: fileKeys.needs(id), queryFn: () => getCareNeeds(id), enabled });
export const useContacts = (id: string) => useQuery({ queryKey: fileKeys.contacts(id), queryFn: () => listContacts(id) });
export const useAccessLog = (id: string, enabled: boolean) =>
    useQuery({ queryKey: fileKeys.log(id), queryFn: () => listAccessLog(id), enabled });

export type DataArea = 'profile' | 'coordination' | 'health' | 'benefits' | 'manage';

const READ: Record<AccessLevel, DataArea[]> = {
    owner: ['profile', 'coordination', 'health', 'benefits', 'manage'],
    full: ['profile', 'coordination', 'health', 'benefits'],
    read_only: ['profile', 'coordination', 'health', 'benefits'],
    coordination: ['profile', 'coordination']
};
const WRITE: Record<AccessLevel, DataArea[]> = {
    owner: ['profile', 'coordination', 'health', 'benefits'],
    full: ['profile', 'coordination', 'health', 'benefits'],
    read_only: [],
    coordination: ['coordination']
};

/** Consentement en vigueur de la personne aidée pour ce dossier. */
export function activeFileConsent(consents: FileConsent[] | undefined): FileConsent | undefined {
    return consents?.find((c) => c.consent_type === 'care_recipient_data' && c.revoked_at === null);
}

/**
 * Ce que l'interface affiche ou masque. Même matrice que private.can_read / private.can_write dans la
 * base, qui reste seule juge : l'interface évite seulement de proposer une action qui serait refusée.
 */
export function fileAccess(
    level: AccessLevel | undefined,
    recipientConsentActive: boolean,
    myHealthConsent: boolean
): { canRead: (area: DataArea) => boolean; canWrite: (area: DataArea) => boolean } {
    return {
        canRead: (area) => (level ? READ[level].includes(area) : false),
        canWrite: (area) => {
            if (!level) return false;
            if (area === 'manage') return level === 'owner';
            return WRITE[level].includes(area) && recipientConsentActive && (area !== 'health' || myHealthConsent);
        }
    };
}

/** Accès de l'utilisateur courant au dossier, avec les consentements qui conditionnent les écritures. */
export function useFileAccess(fileId: string) {
    const { session } = useSession();
    const members = useMembers(fileId);
    const consents = useFileConsents(fileId);
    const myConsents = useMyConsents();
    const membership = members.data?.find((m) => m.user_id === session?.user.id);
    const recipientConsent = activeFileConsent(consents.data);
    const myHealthConsent = myConsents.data ? activeConsent(myConsents.data, 'health_information') !== undefined : false;
    return {
        isPending: members.isPending || consents.isPending || myConsents.isPending,
        isError: members.isError || consents.isError,
        membership,
        recipientConsent,
        myHealthConsent,
        ...fileAccess(membership?.access_level, recipientConsent !== undefined, myHealthConsent)
    };
}
