import { useQuery } from '@tanstack/react-query';
import { getLatestAnswers, listFilePrograms, listPrograms, listResourcesForAdmin } from '../../lib/benefits';

export const benefitKeys = {
    programs: ['programs'] as const,
    answers: (fileId: string) => ['file', fileId, 'benefit-answers'] as const,
    filePrograms: (fileId: string) => ['file', fileId, 'programs'] as const,
    adminResources: ['admin', 'resources'] as const
};

export const usePrograms = () => useQuery({ queryKey: benefitKeys.programs, queryFn: listPrograms, staleTime: 10 * 60 * 1000 });
export const useBenefitAnswers = (fileId: string) =>
    useQuery({ queryKey: benefitKeys.answers(fileId), queryFn: () => getLatestAnswers(fileId) });
export const useFilePrograms = (fileId: string) =>
    useQuery({ queryKey: benefitKeys.filePrograms(fileId), queryFn: () => listFilePrograms(fileId) });
export const useAdminResources = () => useQuery({ queryKey: benefitKeys.adminResources, queryFn: listResourcesForAdmin });
