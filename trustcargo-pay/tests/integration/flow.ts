/** Helpers that drive a fresh transaction through the workflow for integration tests. */
import { DEFAULT_VEHICLE_MILESTONES } from '@/domain/transaction/contract';
import type { App } from '@/server/app';
import type { Actor } from '@/server/auth/actor';
import { makeDemoPdf } from '@/server/demo/files';
import type { CreateVehicleTransactionInput } from '@/lib/validation/schemas';

export const VIN = '2T3W1RFV7MC123456';

export function input(overrides: Partial<CreateVehicleTransactionInput> = {}): CreateVehicleTransactionInput {
    return {
        vehicle: {
            make: 'Toyota',
            model: 'RAV4',
            year: 2021,
            vin: VIN,
            mileageKm: 62300,
            declaredCondition: 'GOOD',
            originCountry: 'CA',
            destinationCountry: 'SN'
        },
        price: { amount: '18500', currency: 'CAD' },
        buyer: { fullName: 'Awa Ndiaye', email: 'awa.ndiaye@demo.trustcargo.test' },
        terms: {
            goodsDescription: 'Toyota RAV4 2021',
            sellerResponsibilities: 'Documents et livraison au port',
            buyerResponsibilities: 'Paiement via partenaire',
            inspectionTerms: 'Inspection indépendante',
            shippingTerms: 'CFR Dakar',
            deliveryTerms: 'Port de Dakar',
            releaseTerms: 'Approbation explicite',
            refundTerms: 'Montants non versés',
            disputeProcedure: 'Procédure contradictoire',
            deadlines: { inspectionDays: 7, shippingDays: 21, deliveryDays: 45, reviewDays: 7 }
        },
        milestones: DEFAULT_VEHICLE_MILESTONES,
        ...overrides
    };
}

export const pdf = (name = 'doc') => ({ bytes: makeDemoPdf(name, ['test']), fileName: `${name}.pdf`, declaredMimeType: 'application/pdf' });

export async function dealerOrgId(app: App) {
    return app.deps.uow.run(async (db) => (await db.organizations.findOne({ legalName: 'Autos Saint-Laurent Export inc.' }))!.id);
}

export async function createAndInvite(app: App, seller: Actor, overrides: Partial<CreateVehicleTransactionInput> = {}) {
    const tx = await app.transactions.createVehicleTransaction(
        seller,
        input({ sellerOrganizationId: await dealerOrgId(app), ...overrides })
    );
    await app.documents.upload(
        seller,
        { transactionId: tx.id, type: 'TITLE', title: 'Titre', extracted: { vin: VIN, ownerName: 'Julien Tremblay' } },
        pdf('titre')
    );
    await app.documents.upload(
        seller,
        {
            transactionId: tx.id,
            type: 'INVOICE',
            title: 'Facture',
            extracted: { amount: overrides.price?.amount ?? '18500', amountCurrency: 'CAD' }
        },
        pdf('facture')
    );
    const { links } = await app.transactions.sendInvitations(seller, tx.id);
    const token = (role: string) => links.find((l) => l.role === role)!.url.split('/invite/')[1]!;
    return { tx, token };
}

export async function agree(app: App, seller: Actor, buyer: Actor, txId: string) {
    const v = await app.views.transaction(seller, txId);
    const decision = { contractVersionId: v.contract!.currentVersionId, contentHash: v.contract!.contentHash, decision: 'ACCEPTED' };
    await app.transactions.decideContract(seller, txId, decision);
    return app.transactions.decideContract(buyer, txId, decision);
}

export async function toInProgress(app: App, seller: Actor, buyer: Actor) {
    const { tx, token } = await createAndInvite(app, seller);
    await app.transactions.acceptInvitation(buyer, token('BUYER'));
    await agree(app, seller, buyer, tx.id);
    const instruction = await app.payments.requestFundingInstructions(buyer, tx.id);
    await app.mockProvider.simulateFunding(instruction.providerReference);
    return { txId: tx.id, instruction };
}

export async function submitMilestone(app: App, seller: Actor, txId: string, index: number) {
    const v = await app.views.transaction(seller, txId);
    const m = v.milestones[index]!;
    for (const type of m.missingEvidence) {
        await app.documents.upload(
            seller,
            {
                transactionId: txId,
                type,
                title: type,
                milestoneId: m.id,
                extracted: type === 'BILL_OF_LADING' ? { vin: VIN, consignee: 'Awa Ndiaye', portOfDischarge: 'Dakar' } : {}
            },
            pdf(type)
        );
    }
    await app.milestones.submit(seller, txId, m.id);
    return m.id;
}

export async function payAllSubmitted(app: App) {
    for (const t of app.mockProvider.pendingTransfers().filter((x) => x.status === 'SUBMITTED'))
        await app.mockProvider.simulateTransferOutcome(t.reference, 'PAID');
}
