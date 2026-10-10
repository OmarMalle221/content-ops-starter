/** Other external capabilities, each behind an adapter so real vendors can be plugged in later. */
import type { CheckResult, IdentityDocumentType, ScreeningResult } from '@/domain/model';

export interface Clock {
    now(): Date;
}

export interface IdGenerator {
    id(): string;
}

export interface IdentityVerificationProvider {
    readonly name: string;
    readonly simulated: boolean;
    startVerification(subject: { id: string; fullName: string; country: string }): Promise<{ providerReference: string }>;
    /** Result as reported by the provider. Mock: deterministic based on the requested outcome. */
    fetchResult(
        providerReference: string,
        simulateOutcome?: 'APPROVE' | 'REJECT' | 'REVIEW'
    ): Promise<{
        status: 'VERIFIED' | 'REJECTED' | 'PENDING';
        verifiedName?: string;
        documentType?: IdentityDocumentType;
        documentCountry?: string;
        documentExpiresAt?: string;
        checks: { code: string; result: CheckResult }[];
    }>;
}

export interface ScreeningProvider {
    readonly name: string;
    readonly simulated: boolean;
    screen(subject: {
        id: string;
        type: 'USER' | 'ORGANIZATION';
        name: string;
        country: string;
    }): Promise<Pick<ScreeningResult, 'result' | 'providerReference' | 'listsChecked'>>;
}

export interface FileStorage {
    put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
    get(key: string): Promise<Uint8Array | undefined>;
    /**
     * Removes an object (no-op when it does not exist). Best effort, used only to clean up the object of an upload
     * whose unit of work failed: an adapter without it leaves such objects unreferenced in the private store.
     */
    delete?(key: string): Promise<void>;
}

export interface FileScanner {
    readonly engine: string;
    scan(bytes: Uint8Array): Promise<'CLEAN' | 'INFECTED' | 'ERROR'>;
}
