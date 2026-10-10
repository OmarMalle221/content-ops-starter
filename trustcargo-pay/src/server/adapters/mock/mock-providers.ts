import { randomToken } from '@/server/security/crypto';
import type { Clock, FileScanner, FileStorage, IdentityVerificationProvider, ScreeningProvider } from '@/server/ports/providers';

export class SystemClock implements Clock {
    private offsetMs = 0;
    private frozen: Date | undefined;
    now(): Date {
        return this.frozen ? new Date(this.frozen) : new Date(Date.now() + this.offsetMs);
    }
    /** Used by the demo seeder and tests to place events in the past. */
    freeze(at: Date) {
        this.frozen = new Date(at);
    }
    advance(ms: number) {
        if (this.frozen) this.frozen = new Date(this.frozen.getTime() + ms);
        else this.offsetMs += ms;
    }
    unfreeze() {
        this.frozen = undefined;
    }
}

/** SIMULATION — no identity is actually verified. */
export class MockIdentityProvider implements IdentityVerificationProvider {
    readonly name = 'mock-kyc';
    readonly simulated = true;
    private readonly subjects = new Map<string, { fullName: string; country: string }>();

    async startVerification(subject: { id: string; fullName: string; country: string }) {
        const providerReference = `sim_kyc_${randomToken(8)}`;
        this.subjects.set(providerReference, subject);
        return { providerReference };
    }

    async fetchResult(providerReference: string, simulateOutcome: 'APPROVE' | 'REJECT' | 'REVIEW' = 'APPROVE') {
        const subject = this.subjects.get(providerReference);
        if (simulateOutcome === 'REVIEW')
            return { status: 'PENDING' as const, checks: [{ code: 'DOCUMENT_AUTHENTICITY', result: 'REVIEW' as const }] };
        if (simulateOutcome === 'REJECT') {
            return {
                status: 'REJECTED' as const,
                checks: [
                    { code: 'DOCUMENT_AUTHENTICITY', result: 'FAIL' as const },
                    { code: 'LIVENESS', result: 'PASS' as const }
                ]
            };
        }
        return {
            status: 'VERIFIED' as const,
            verifiedName: subject?.fullName,
            documentType: 'PASSPORT' as const,
            documentCountry: subject?.country,
            documentExpiresAt: '2031-06-30',
            checks: [
                { code: 'DOCUMENT_AUTHENTICITY', result: 'PASS' as const },
                { code: 'LIVENESS', result: 'PASS' as const },
                { code: 'FACE_MATCH', result: 'PASS' as const }
            ]
        };
    }
}

/**
 * SIMULATION — does not query any sanctions list. Names containing the fictitious marker
 * "SANCTIONTEST" return a potential match so the review workflow can be exercised.
 */
export class MockScreeningProvider implements ScreeningProvider {
    readonly name = 'mock-screening';
    readonly simulated = true;
    async screen(subject: { id: string; name: string }) {
        const hit = /sanctiontest/i.test(subject.name);
        return {
            result: hit ? ('POTENTIAL_MATCH' as const) : ('NO_MATCH' as const),
            // One reference per screening call, as a real provider issues (screening_results is unique on it).
            providerReference: `sim_scr_${randomToken(8)}`,
            listsChecked: ['SIMULATED-LIST (aucune liste réelle consultée)']
        };
    }
}

export class MemoryFileStorage implements FileStorage {
    private readonly files = new Map<string, { bytes: Uint8Array; contentType: string }>();
    async put(key: string, bytes: Uint8Array, contentType: string) {
        this.files.set(key, { bytes: new Uint8Array(bytes), contentType });
    }
    async get(key: string) {
        const f = this.files.get(key);
        return f ? new Uint8Array(f.bytes) : undefined;
    }
}

/** Placeholder scanner: detects the EICAR test signature only. Production needs a real AV engine. */
export class EicarOnlyScanner implements FileScanner {
    readonly engine = 'eicar-signature-check (placeholder)';
    async scan(bytes: Uint8Array) {
        const text = Buffer.from(bytes).toString('latin1');
        return text.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? ('INFECTED' as const) : ('CLEAN' as const);
    }
}
