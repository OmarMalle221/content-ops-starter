import { describe, expect, it } from 'vitest';
import { evaluateRisk, type PartyFacts, type RiskContext } from '@/domain/risk/engine';
import { namesMatch } from '@/domain/risk/names';
import { money } from '@/domain/money';
import type { Document, PaymentAccount } from '@/domain/model';

const now = new Date('2026-10-09T12:00:00Z');

function party(role: 'SELLER' | 'BUYER', name: string, overrides: Partial<PartyFacts> = {}): PartyFacts {
    const id = role.toLowerCase();
    return {
        party: {
            id: `p-${id}`,
            transactionId: 't1',
            role,
            userId: `u-${id}`,
            displayName: name,
            email: `${id}@example.test`,
            status: 'JOINED',
            createdAt: now.toISOString()
        },
        user: {
            id: `u-${id}`,
            email: `${id}@example.test`,
            fullName: name,
            country: role === 'SELLER' ? 'CA' : 'SN',
            locale: 'fr',
            platformRoles: [],
            kycStatus: 'VERIFIED',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00Z',
            isDemo: true
        },
        kyc: {
            id: `k-${id}`,
            subjectType: 'USER',
            subjectId: `u-${id}`,
            provider: 'mock',
            providerReference: 'r',
            status: 'VERIFIED',
            level: 'BASIC',
            verifiedName: name,
            documentExpiresAt: '2030-01-01',
            checks: [],
            simulated: true,
            createdAt: '2026-01-01T00:00:00Z'
        },
        payoutAccounts: [],
        sessions: [],
        ...overrides
    };
}

function doc(type: Document['type'], extracted: Document['extracted'], id = `d-${type}`): Document {
    return {
        id,
        logicalId: id,
        version: 1,
        transactionId: 't1',
        ownerUserId: 'u-seller',
        type,
        title: type,
        fileName: 'f.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sha256: 'x',
        storageKey: 'k',
        status: 'PENDING_REVIEW',
        visibleToRoles: ['SELLER', 'BUYER'],
        extracted,
        extractionSource: 'DECLARED',
        scan: { status: 'CLEAN', engine: 'mock' },
        uploadedAt: now.toISOString()
    };
}

function account(overrides: Partial<PaymentAccount> = {}): PaymentAccount {
    return {
        id: 'pa1',
        ownerType: 'USER',
        ownerId: 'u-seller',
        holderName: 'Julien Tremblay',
        currency: 'CAD',
        country: 'CA',
        bankName: 'Banque fictive',
        maskedIdentifier: '•••• 4821',
        providerToken: 'tok_1',
        status: 'VERIFIED',
        createdAt: '2026-01-01T00:00:00Z',
        ...overrides
    };
}

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
    return {
        now,
        transaction: {
            id: 't1',
            reference: 'TC-1',
            type: 'VEHICLE_PURCHASE',
            status: 'AWAITING_FUNDING',
            title: 'RAV4',
            amount: money(1_850_000n, 'CAD'),
            corridorId: 'c1',
            createdBy: 'u-seller',
            version: 1,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            isDemo: true
        },
        corridor: {
            id: 'c1',
            code: 'CA-SN',
            originCountry: 'CA',
            destinationCountry: 'SN',
            enabled: true,
            allowedCurrencies: ['CAD'],
            reviewThresholdMinor: { CAD: '5000000' },
            expectedDischargePorts: ['Dakar'],
            requiredDocumentsBeforeFunding: ['TITLE', 'INVOICE'],
            updatedAt: now.toISOString()
        },
        parties: [party('SELLER', 'Julien Tremblay', { payoutAccounts: [account()] }), party('BUYER', 'Awa Ndiaye')],
        vehicle: {
            id: 'v1',
            transactionId: 't1',
            make: 'Toyota',
            model: 'RAV4',
            year: 2021,
            vin: '2T3W1RFV7MC123456',
            mileageKm: 62000,
            declaredCondition: 'GOOD',
            originCountry: 'CA',
            destinationCountry: 'SN'
        },
        documents: [
            doc('TITLE', { vin: '2T3W1RFV7MC123456', ownerName: 'Julien Tremblay' }),
            doc('INVOICE', { amount: { amountMinor: '1850000', currency: 'CAD' } })
        ],
        contractVersions: [],
        sellerTransactionsLast24h: 1,
        sellerPastAmountsMinor: [],
        coolingOffHours: 72,
        ...overrides
    };
}

const ids = (c: RiskContext) =>
    evaluateRisk(c)
        .map((a) => a.ruleId)
        .sort();

describe('risk engine', () => {
    it('raises nothing on a consistent transaction', () => {
        expect(ids(ctx())).toEqual([]);
    });

    it('flags VIN mismatches across documents with an explainable reason', () => {
        const c = ctx({
            documents: [
                doc('TITLE', { vin: '2T3W1RFV7MC123457', ownerName: 'Julien Tremblay' }),
                doc('INVOICE', { amount: { amountMinor: '1850000', currency: 'CAD' } })
            ]
        });
        const alerts = evaluateRisk(c);
        const vin = alerts.find((a) => a.ruleId === 'VIN_DOCUMENT_MISMATCH')!;
        expect(vin.severity).toBe('CRITICAL');
        expect(vin.blocksFundsMovement).toBe(true);
        expect(vin.reasons[0]).toEqual({
            code: 'VIN_DIFFERS',
            params: { documentType: 'TITLE', documentVin: '2T3W1RFV7MC123457', declaredVin: '2T3W1RFV7MC123456' }
        });
        expect(alerts.some((a) => 'score' in a || 'probability' in a)).toBe(false);
    });

    it('flags a seller who is not the title holder, ignoring accents and order', () => {
        expect(ids(ctx({ documents: [doc('TITLE', { ownerName: 'TREMBLAY Julien' }), doc('INVOICE', {})] }))).toEqual([]);
        expect(ids(ctx({ documents: [doc('TITLE', { ownerName: 'Marc Gagnon' }), doc('INVOICE', {})] }))).toEqual([
            'SELLER_NOT_TITLE_HOLDER'
        ]);
    });

    it('flags invoice / export declaration values inconsistent with the contract', () => {
        const c = ctx({
            documents: [
                doc('TITLE', {}),
                doc('INVOICE', { amount: { amountMinor: '1450000', currency: 'CAD' } }),
                doc('EXPORT_DECLARATION', { amount: { amountMinor: '900000', currency: 'CAD' } })
            ]
        });
        expect(ids(c)).toEqual(['DECLARED_VALUE_INCONSISTENT', 'DOCUMENT_AMOUNT_MISMATCH']);
    });

    it('flags missing documents before funding and a malformed VIN', () => {
        const c = ctx({ documents: [], vehicle: { ...ctx().vehicle!, vin: '2T3W1RFV8MC123456' } });
        expect(ids(c)).toEqual(['MISSING_REQUIRED_DOCUMENTS', 'VIN_MALFORMED']);
    });

    it('flags payout account changes inside the cooling-off window and holder mismatches', () => {
        const replaced = account({
            id: 'pa2',
            holderName: 'Garage Inconnu SARL',
            replacesAccountId: 'pa1',
            createdAt: '2026-10-09T08:00:00Z',
            providerToken: 'tok_2'
        });
        const c = ctx({ parties: [party('SELLER', 'Julien Tremblay', { payoutAccounts: [replaced] }), party('BUYER', 'Awa Ndiaye')] });
        expect(ids(c)).toEqual(['BENEFICIARY_CHANGED_RECENTLY', 'PAYOUT_ACCOUNT_HOLDER_MISMATCH']);
    });

    it('flags restricted-party screening results and shared devices between buyer and seller', () => {
        const session = { id: 's', userId: 'x', at: now.toISOString(), country: 'CA', deviceFingerprintHash: 'dev1', ipHash: 'ip' };
        const c = ctx({
            parties: [
                party('SELLER', 'Julien Tremblay', { payoutAccounts: [account()], sessions: [session] }),
                party('BUYER', 'Awa Ndiaye', {
                    sessions: [session],
                    screening: {
                        id: 'sc1',
                        subjectType: 'USER',
                        subjectId: 'u-buyer',
                        provider: 'mock-screening',
                        providerReference: 'r',
                        result: 'POTENTIAL_MATCH',
                        listsChecked: [],
                        simulated: true,
                        checkedAt: now.toISOString()
                    }
                })
            ]
        });
        expect(ids(c)).toEqual(['LINKED_ACCOUNTS', 'RESTRICTED_PARTY_SCREENING']);
    });

    it('flags shipping documents whose consignee or port do not match', () => {
        const c = ctx({
            documents: [
                ...ctx().documents,
                doc('EXPORT_DECLARATION', {}),
                doc('BILL_OF_LADING', { consignee: 'Moussa Diop', portOfDischarge: 'Lagos', vin: '2T3W1RFV7MC123456' })
            ]
        });
        const alert = evaluateRisk(c).find((a) => a.ruleId === 'SHIPPING_DOCUMENT_INCONSISTENT')!;
        expect(alert.reasons.map((r) => r.code)).toEqual(['CONSIGNEE_NOT_BUYER', 'UNEXPECTED_DISCHARGE_PORT']);
    });

    it('flags unusual amounts, velocity and repeated amendments', () => {
        const c = ctx({
            transaction: { ...ctx().transaction, amount: money(9_000_000n, 'CAD') },
            sellerTransactionsLast24h: 4,
            contractVersions: [{}, {}, {}] as never,
            sellerPastAmountsMinor: [1_000_000n, 1_200_000n, 900_000n],
            documents: [doc('TITLE', {}), doc('INVOICE', {})]
        });
        const alerts = evaluateRisk(c);
        expect(alerts.map((a) => a.ruleId).sort()).toEqual(['AMOUNT_UNUSUAL', 'REPEATED_CONTRACT_AMENDMENTS', 'TRANSACTION_VELOCITY']);
        expect(alerts.find((a) => a.ruleId === 'AMOUNT_UNUSUAL')!.reasons.map((r) => r.code)).toEqual([
            'ABOVE_CORRIDOR_THRESHOLD',
            'ABOVE_SELLER_HISTORY'
        ]);
    });

    it('produces stable fingerprints for de-duplication', () => {
        const c = ctx({ documents: [] });
        expect(evaluateRisk(c).map((a) => a.fingerprint)).toEqual(evaluateRisk(c).map((a) => a.fingerprint));
    });

    it('compares names without accents, case or legal suffixes', () => {
        expect(namesMatch('Autos Laurentides Export Inc.', 'AUTOS LAURENTIDES EXPORT')).toBe(true);
        expect(namesMatch('Aïssatou Fall', 'aissatou FALL')).toBe(true);
        expect(namesMatch('Awa Ndiaye', 'Awa Ndiaye Sow')).toBe(false);
    });
});
