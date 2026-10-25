import { useQuery } from '@tanstack/react-query';
import { getCurrentExtraction, getDocument, listDocuments, listMedications, listTimeline } from '../../lib/documents';
import type { FileConsent } from '../../lib/careFiles';
import { useFileConsents } from '../files/useFile';

export const docKeys = {
    list: (fileId: string) => ['file', fileId, 'documents'] as const,
    document: (id: string) => ['document', id] as const,
    extraction: (id: string) => ['document', id, 'extraction'] as const,
    timeline: (fileId: string) => ['file', fileId, 'timeline'] as const,
    medications: (fileId: string) => ['file', fileId, 'medications'] as const
};

export const useDocuments = (fileId: string, enabled = true) =>
    useQuery({ queryKey: docKeys.list(fileId), queryFn: () => listDocuments(fileId), enabled });

/** Un document en cours de lecture est relu toutes les 3 secondes. */
export const useDocument = (id: string) =>
    useQuery({
        queryKey: docKeys.document(id),
        queryFn: () => getDocument(id),
        refetchInterval: (query) => (query.state.data?.status === 'processing' ? 3000 : false)
    });

export const useExtraction = (id: string, enabled: boolean) =>
    useQuery({ queryKey: docKeys.extraction(id), queryFn: () => getCurrentExtraction(id), enabled });

export const useTimeline = (fileId: string, enabled = true) =>
    useQuery({ queryKey: docKeys.timeline(fileId), queryFn: () => listTimeline(fileId), enabled });

export const useMedications = (fileId: string, enabled = true) =>
    useQuery({ queryKey: docKeys.medications(fileId), queryFn: () => listMedications(fileId), enabled });

/** Autorisation de lecture automatique en vigueur pour ce dossier. */
export function activeAiConsent(consents: FileConsent[] | undefined): FileConsent | undefined {
    return consents?.find((c) => c.consent_type === 'ai_document_processing' && c.revoked_at === null);
}

export function useAiConsent(fileId: string) {
    const consents = useFileConsents(fileId);
    return { isPending: consents.isPending, active: activeAiConsent(consents.data) };
}
