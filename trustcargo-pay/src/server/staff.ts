import 'server-only';
import type { PlatformRole } from '@/domain/model';

export const ALL_STAFF: PlatformRole[] = [
    'compliance_analyst',
    'document_reviewer',
    'dispute_manager',
    'finance_operator',
    'platform_admin',
    'auditor'
];
export const TX_READERS: PlatformRole[] = ['compliance_analyst', 'dispute_manager', 'finance_operator', 'auditor', 'document_reviewer'];
