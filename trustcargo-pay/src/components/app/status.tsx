import {
    AlertTriangle,
    CheckCircle2,
    CircleDashed,
    Clock,
    FileCheck2,
    Gavel,
    Handshake,
    Hourglass,
    Landmark,
    RotateCcw,
    ShieldCheck,
    UserCheck,
    Users,
    XCircle
} from 'lucide-react';
import type { TransactionStatus } from '@/domain/model';
import { Badge } from '@/components/ui/badge';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export const STATUS_TONE: Record<TransactionStatus, Tone> = {
    DRAFT: 'neutral',
    AWAITING_PARTIES: 'info',
    IDENTITY_VERIFICATION: 'info',
    AWAITING_AGREEMENT: 'info',
    AWAITING_FUNDING: 'warning',
    FUNDING_PENDING: 'warning',
    FUNDS_CONFIRMED: 'primary',
    IN_PROGRESS: 'primary',
    MILESTONE_REVIEW: 'warning',
    DISPUTED: 'danger',
    COMPLETED: 'success',
    CANCELLED: 'neutral',
    REFUND_PENDING: 'warning',
    REFUNDED: 'neutral'
};

const ICONS: Record<TransactionStatus, typeof Clock> = {
    DRAFT: CircleDashed,
    AWAITING_PARTIES: Users,
    IDENTITY_VERIFICATION: UserCheck,
    AWAITING_AGREEMENT: Handshake,
    AWAITING_FUNDING: Landmark,
    FUNDING_PENDING: Hourglass,
    FUNDS_CONFIRMED: ShieldCheck,
    IN_PROGRESS: Clock,
    MILESTONE_REVIEW: FileCheck2,
    DISPUTED: Gavel,
    COMPLETED: CheckCircle2,
    CANCELLED: XCircle,
    REFUND_PENDING: RotateCcw,
    REFUNDED: RotateCcw
};

export function TransactionStatusBadge({ status, label }: { status: TransactionStatus; label: string }) {
    const Icon = ICONS[status];
    return (
        <Badge tone={STATUS_TONE[status]}>
            <Icon aria-hidden />
            {label}
        </Badge>
    );
}

export function ToneBadge({ tone, children, warning }: { tone: Tone; children: React.ReactNode; warning?: boolean }) {
    return (
        <Badge tone={tone}>
            {warning && <AlertTriangle aria-hidden />}
            {children}
        </Badge>
    );
}

export function toneFor(status: string): Tone {
    if (
        [
            'VERIFIED',
            'RELEASED',
            'PAID',
            'REFUNDED',
            'FUNDED',
            'JOINED',
            'ACCEPTED',
            'RESOLVED',
            'MATCHED',
            'PROCESSED',
            'CLEAN',
            'ACTIVE_OK'
        ].includes(status)
    )
        return 'success';
    if (['REJECTED', 'FAILED', 'QUARANTINED', 'DECLINED', 'CRITICAL', 'DISCREPANCIES', 'INFECTED'].includes(status)) return 'danger';
    if (
        [
            'PENDING',
            'PENDING_REVIEW',
            'SUBMITTED',
            'REQUESTED',
            'PROCESSING',
            'INVITED',
            'AWAITING_RESPONSE',
            'UNDER_REVIEW',
            'OPEN',
            'IN_REVIEW',
            'HIGH',
            'CHANGES_REQUESTED',
            'EXECUTING',
            'APPROVED'
        ].includes(status)
    )
        return 'warning';
    if (['ACTIVE', 'MEDIUM', 'CREATED'].includes(status)) return 'info';
    return 'neutral';
}
