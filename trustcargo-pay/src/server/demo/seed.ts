/**
 * Seed data. Reference data is inserted directly; scenarios are produced by driving the real
 * services (and the mock partner's signed events) so that statuses, ledger, audit chain and risk
 * alerts are exactly what the product would produce. Everything is fictitious.
 *
 * - seedPlatformReferenceData: what any deployment needs to operate (security settings, corridors, the
 *   simulated partner connection). The only seed of a database with real accounts (AUTH_PROVIDER=supabase).
 * - seedDemoPersonas / seedDemoScenarios: persona demo only (AUTH_PROVIDER=demo). Personas never share a
 *   database with real accounts (src/server/instance.ts).
 */
import { DEFAULT_VEHICLE_MILESTONES } from '@/domain/transaction/contract';
import type { CreateVehicleTransactionInput } from '@/lib/validation/schemas';
import type { App } from '@/server/app';
import type { Actor } from '@/server/auth/actor';
import { pseudonymize } from '@/server/security/crypto';
import { DEFAULT_SECURITY_SETTINGS } from '@/server/services/context';
import { makeDemoPdf, makeDemoPng } from './files';
import { DEMO_TOTP_SECRET, PERSONAS } from './personas';

const DAY = 86_400_000;
const T0 = '2026-01-10T14:00:00.000Z';

/** Reference data needed to operate, with or without personas. */
export async function seedPlatformReferenceData(app: App) {
    const { deps } = app;
    const t0 = T0;
    await deps.uow.run(async (db) => {
        await db.securitySettings.insert({ id: 'default', ...DEFAULT_SECURITY_SETTINGS, updatedAt: t0 });
        await db.corridors.insert({
            id: deps.ids.id(),
            code: 'CA-SN',
            originCountry: 'CA',
            destinationCountry: 'SN',
            enabled: true,
            allowedCurrencies: ['CAD', 'USD', 'EUR', 'XOF'],
            reviewThresholdMinor: { CAD: '5000000', USD: '3700000', EUR: '3400000', XOF: '2200000000' },
            expectedDischargePorts: ['Dakar', 'Port de Dakar', 'Port autonome de Dakar'],
            requiredDocumentsBeforeFunding: ['TITLE', 'INVOICE'],
            updatedAt: t0
        });
        await db.corridors.insert({
            id: deps.ids.id(),
            code: 'CA-CI',
            originCountry: 'CA',
            destinationCountry: 'CI',
            enabled: false,
            allowedCurrencies: ['CAD', 'XOF', 'EUR'],
            reviewThresholdMinor: { CAD: '5000000' },
            expectedDischargePorts: ['Abidjan'],
            requiredDocumentsBeforeFunding: ['TITLE', 'INVOICE'],
            updatedAt: t0
        });
        await db.providerConnections.insert({
            id: deps.ids.id(),
            provider: 'mock',
            displayName: 'Partenaire financier simulé',
            environment: 'SIMULATION',
            status: 'ACTIVE',
            capabilities: ['payment_instructions', 'webhooks', 'authorized_release', 'authorized_refund', 'statements'],
            webhookSecretRef: 'MOCK_PROVIDER_WEBHOOK_SECRET',
            regulatoryStatusNote: 'Simulation uniquement — aucun partenaire juridiquement habilité n’est intégré. Aucun fonds réel.',
            createdAt: t0
        });
    });
}

/** Persona demo only: the fictitious personas with their verifications, organisations, payout account and sessions. */
export async function seedDemoPersonas(app: App) {
    const { deps } = app;
    const t0 = T0;
    await deps.uow.run(async (db) => {
        const ids: Record<string, string> = {};
        for (const p of PERSONAS) {
            const id = deps.ids.id();
            ids[p.key] = id;
            await db.users.insert({
                id,
                email: p.email,
                fullName: p.fullName,
                country: p.country,
                city: p.city,
                locale: p.locale,
                platformRoles: p.platformRoles,
                kycStatus: p.kyc,
                status: 'ACTIVE',
                mfaTotpSecret: DEMO_TOTP_SECRET,
                createdAt: t0,
                isDemo: true
            });
            if (p.kyc === 'VERIFIED') {
                await db.identityVerifications.insert({
                    id: deps.ids.id(),
                    subjectType: 'USER',
                    subjectId: id,
                    provider: 'mock-kyc',
                    providerReference: `sim_kyc_seed_${p.key}`,
                    status: 'VERIFIED',
                    level: 'BASIC',
                    verifiedName: p.fullName,
                    documentType: 'PASSPORT',
                    documentCountry: p.country,
                    documentExpiresAt: '2031-06-30',
                    checks: [
                        { code: 'DOCUMENT_AUTHENTICITY', result: 'PASS' },
                        { code: 'LIVENESS', result: 'PASS' },
                        { code: 'FACE_MATCH', result: 'PASS' }
                    ],
                    simulated: true,
                    createdAt: t0,
                    completedAt: t0
                });
                await db.screeningResults.insert({
                    id: deps.ids.id(),
                    subjectType: 'USER',
                    subjectId: id,
                    provider: 'mock-screening',
                    providerReference: `sim_scr_seed_${p.key}`,
                    result: 'NO_MATCH',
                    listsChecked: ['SIMULATED-LIST (aucune liste réelle consultée)'],
                    simulated: true,
                    checkedAt: t0
                });
            }
        }
        const orgs = [
            {
                key: 'dealer',
                owner: 'seller',
                legalName: 'Autos Saint-Laurent Export inc.',
                tradeName: 'Autos Saint-Laurent',
                registrationNumber: 'NEQ-DEMO-1170000001',
                country: 'CA',
                city: 'Montréal',
                type: 'DEALER' as const,
                kyb: 'VERIFIED' as const
            },
            {
                key: 'inspection',
                owner: 'inspector',
                legalName: 'Inspections Rive-Sud inc.',
                registrationNumber: 'NEQ-DEMO-1170000002',
                country: 'CA',
                city: 'Longueuil',
                type: 'INSPECTION_COMPANY' as const,
                kyb: 'VERIFIED' as const
            },
            {
                key: 'forwarder',
                owner: 'forwarder',
                legalName: 'Transit Atlantique SARL',
                registrationNumber: 'RCCM-DEMO-SN-DKR-0001',
                country: 'SN',
                city: 'Dakar',
                type: 'FREIGHT_FORWARDER' as const,
                kyb: 'VERIFIED' as const
            },
            {
                key: 'buyerco',
                owner: 'buyer2',
                legalName: 'Fall Logistique SARL',
                registrationNumber: 'RCCM-DEMO-SN-THS-0002',
                country: 'SN',
                city: 'Thiès',
                type: 'BUYER_BUSINESS' as const,
                kyb: 'PENDING' as const
            }
        ];
        for (const o of orgs) {
            const id = deps.ids.id();
            ids[`org:${o.key}`] = id;
            await db.organizations.insert({
                id,
                legalName: o.legalName,
                tradeName: o.tradeName,
                registrationNumber: o.registrationNumber,
                country: o.country,
                city: o.city,
                type: o.type,
                kybStatus: o.kyb,
                createdAt: t0
            });
            await db.organizationMembers.insert({
                id: deps.ids.id(),
                organizationId: id,
                userId: ids[o.owner]!,
                role: 'OWNER',
                createdAt: t0
            });
            const owner = PERSONAS.find((p) => p.key === o.owner)!;
            await db.beneficialOwners.insert({
                id: deps.ids.id(),
                organizationId: id,
                fullName: owner.fullName,
                ownershipBps: 10_000,
                country: owner.country,
                verificationStatus: o.kyb,
                createdAt: t0
            });
        }
        await db.paymentAccounts.insert({
            id: deps.ids.id(),
            ownerType: 'ORGANIZATION',
            ownerId: ids['org:dealer']!,
            holderName: 'Autos Saint-Laurent Export inc.',
            currency: 'CAD',
            country: 'CA',
            bankName: 'Banque fictive du Québec (démo)',
            maskedIdentifier: '•••• 4821',
            providerToken: 'sim_vault_seed_dealer_cad',
            status: 'VERIFIED',
            createdAt: '2026-01-15T15:00:00.000Z',
            verifiedAt: '2026-01-15T15:00:00.000Z'
        });
        const sessions: [string, string, string][] = [
            ['seller', 'CA', 'dev-julien-laptop'],
            ['buyer', 'SN', 'dev-awa-phone'],
            ['buyer2', 'SN', 'dev-cheikh-phone']
        ];
        for (const [key, country, device] of sessions) {
            // Stored like real sessions: keyed pseudonyms, never the raw device / IP identifiers.
            await db.sessionEvents.insert({
                id: deps.ids.id(),
                userId: ids[key]!,
                at: t0,
                country,
                deviceFingerprintHash: pseudonymize(app.config.sessionSecret, `demo-device:${device}`),
                ipHash: pseudonymize(app.config.sessionSecret, `demo-ip:${key}`)
            });
        }
    });
}

/** Platform reference data and the demo personas, in one unit of work (persona demo and tests). */
export async function seedReferenceData(app: App) {
    await app.deps.uow.run(async () => {
        await seedPlatformReferenceData(app);
        await seedDemoPersonas(app);
    });
}

export async function personaActor(app: App, key: string): Promise<Actor> {
    const persona = PERSONAS.find((p) => p.key === key)!;
    const user = await app.deps.uow.run((db) => db.users.findOne({ email: persona.email }));
    return {
        kind: 'USER',
        userId: user!.id,
        email: user!.email,
        platformRoles: user!.platformRoles,
        mfaVerifiedAt: app.clock.now().toISOString(),
        sessionId: `seed-${key}`
    };
}

function vehicleInput(
    v: { make: string; model: string; year: number; vin: string; mileageKm: number; color: string; amount: string },
    buyer: { fullName: string; email: string },
    orgId: string | undefined,
    inspector?: { fullName: string; email: string; companyName?: string }
): CreateVehicleTransactionInput {
    return {
        vehicle: {
            make: v.make,
            model: v.model,
            year: v.year,
            vin: v.vin,
            mileageKm: v.mileageKm,
            declaredCondition: 'GOOD',
            conditionNotes: 'Entretien complet documenté. Pneus d’hiver inclus. Légères rayures sur le pare-chocs arrière.',
            exteriorColor: v.color,
            originCountry: 'CA',
            destinationCountry: 'SN'
        },
        price: { amount: v.amount, currency: 'CAD' },
        buyer,
        inspector,
        sellerOrganizationId: orgId,
        terms: {
            goodsDescription: `${v.make} ${v.model} ${v.year}, VIN ${v.vin}, ${v.mileageKm.toLocaleString('fr-CA')} km, couleur ${v.color}, vendu en l’état décrit dans le rapport d’inspection.`,
            sellerResponsibilities:
                'Fournir le titre de propriété, la facture, le rapport d’inspection indépendant, le connaissement et la déclaration d’exportation. Livrer le véhicule au port de Montréal.',
            buyerResponsibilities:
                'Verser les fonds auprès du partenaire financier selon ses instructions. Examiner les preuves dans les délais convenus. Prendre en charge le dédouanement à Dakar.',
            inspectionTerms:
                'Inspection indépendante avant expédition (mécanique, carrosserie, concordance du VIN). Le rapport est partagé avec les deux parties.',
            shippingTerms: 'CFR Dakar (Incoterms® 2020) — transport maritime roulier depuis le port de Montréal.',
            deliveryTerms: 'Remise du véhicule à l’acheteur au port autonome de Dakar après dédouanement.',
            releaseTerms:
                'Chaque versement nécessite l’approbation explicite de l’acheteur ou une décision de litige, puis une instruction autorisée exécutée par le partenaire financier.',
            refundTerms:
                'Remboursement des montants non versés si le véhicule n’est pas expédié dans les délais ou en cas de non-conformité établie.',
            disputeProcedure:
                'Ouverture motivée d’un litige, réponse contradictoire sous 7 jours, analyse et décision par une personne habilitée selon le présent contrat.',
            deadlines: { inspectionDays: 7, shippingDays: 21, deliveryDays: 45, reviewDays: 7 }
        },
        milestones: DEFAULT_VEHICLE_MILESTONES
    };
}

export async function seedDemoScenarios(app: App) {
    const { clock, mockProvider } = app;
    // Scenarios are placed relative to "now" so invitations and deadlines stay valid whenever the demo starts.
    const today = new Date(app.clock.now());
    today.setUTCHours(13, 0, 0, 0);
    const start = today.getTime() - 38 * DAY;
    clock.freeze(new Date(start));
    try {
        const seller = await personaActor(app, 'seller');
        const buyer = await personaActor(app, 'buyer');
        const buyer2 = await personaActor(app, 'buyer2');
        const inspector = await personaActor(app, 'inspector');
        const forwarder = await personaActor(app, 'forwarder');
        const dealerOrg = await app.deps.uow.run(
            async (db) => (await db.organizations.findOne({ legalName: 'Autos Saint-Laurent Export inc.' }))!.id
        );
        const refresh = async (key: string) => ({ ...(await personaActor(app, key)) });
        const awa = { fullName: 'Awa Ndiaye', email: 'awa.ndiaye@demo.trustcargo.test' };
        const pdf = (title: string, lines: string[]) => ({
            bytes: makeDemoPdf(title, lines),
            fileName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`,
            declaredMimeType: 'application/pdf'
        });
        const tick = (ms: number) => clock.advance(ms);

        async function createAgreed(v: Parameters<typeof vehicleInput>[0], withInspector: boolean): Promise<string> {
            const tx = await app.transactions.createVehicleTransaction(
                seller,
                vehicleInput(
                    v,
                    awa,
                    dealerOrg,
                    withInspector
                        ? {
                              fullName: 'Marie-Ève Gagnon',
                              email: 'marie-eve.gagnon@demo.trustcargo.test',
                              companyName: 'Inspections Rive-Sud inc.'
                          }
                        : undefined
                )
            );
            await app.documents.upload(
                seller,
                {
                    transactionId: tx.id,
                    type: 'TITLE',
                    title: 'Certificat d’immatriculation (titre)',
                    extracted: { vin: v.vin, ownerName: 'Autos Saint-Laurent Export inc.' }
                },
                pdf('Certificat immatriculation', [`VIN: ${v.vin}`, 'Proprietaire: Autos Saint-Laurent Export inc.'])
            );
            await app.documents.upload(
                seller,
                {
                    transactionId: tx.id,
                    type: 'INVOICE',
                    title: 'Facture de vente',
                    extracted: { amount: v.amount, amountCurrency: 'CAD', vin: v.vin }
                },
                pdf('Facture de vente', [`Vehicule: ${v.make} ${v.model} ${v.year}`, `VIN: ${v.vin}`, `Montant: ${v.amount} CAD`])
            );
            await app.documents.upload(
                seller,
                { transactionId: tx.id, type: 'PHOTO', title: 'Photo — vue avant' },
                { bytes: makeDemoPng([90, 110, 140]), fileName: 'photo-avant.png', declaredMimeType: 'image/png' }
            );
            tick(DAY / 4);
            const sent = await app.transactions.sendInvitations(seller, tx.id);
            const tokenFor = (role: string) => sent.links.find((l) => l.role === role)!.url.split('/invite/')[1]!;
            const view = await app.views.transaction(seller, tx.id);
            await app.transactions.decideContract(seller, tx.id, {
                contractVersionId: view.contract!.currentVersionId,
                contentHash: view.contract!.contentHash,
                decision: 'ACCEPTED'
            });
            tick(DAY / 2);
            await app.transactions.acceptInvitation(buyer, tokenFor('BUYER'));
            if (withInspector) await app.transactions.acceptInvitation(inspector, tokenFor('INSPECTOR'));
            await app.transactions.decideContract(buyer, tx.id, {
                contractVersionId: view.contract!.currentVersionId,
                contentHash: view.contract!.contentHash,
                decision: 'ACCEPTED',
                comment: 'Conditions lues et acceptées.'
            });
            return tx.id;
        }

        async function fund(txId: string) {
            tick(DAY);
            const instruction = await app.payments.requestFundingInstructions(buyer, txId);
            tick(DAY);
            await mockProvider.simulateFunding(instruction.providerReference);
        }

        async function completeFirstMilestone(txId: string, vin: string) {
            tick(DAY * 2);
            let view = await app.views.transaction(seller, txId);
            const m1 = view.milestones[0]!;
            const insp = await app.documents.upload(
                view.parties.some((p) => p.role === 'INSPECTOR' && p.status === 'JOINED') ? inspector : seller,
                {
                    transactionId: txId,
                    type: 'INSPECTION_REPORT',
                    title: 'Rapport d’inspection indépendant',
                    milestoneId: m1.id,
                    extracted: { vin }
                },
                pdf('Rapport inspection', [
                    `VIN verifie sur chassis: ${vin}`,
                    'Etat mecanique: bon',
                    'Carrosserie: rayures legeres pare-chocs arriere'
                ])
            );
            void insp;
            view = await app.views.transaction(seller, txId);
            const title = view.documents.find((d) => d.type === 'TITLE')!;
            await app.milestones.attachEvidence(seller, txId, m1.id, title.id);
            tick(DAY / 2);
            await app.milestones.submit(seller, txId, m1.id, 'Inspection réalisée et titre de propriété joint.');
            tick(DAY);
            await app.milestones.review(buyer, txId, m1.id, { decision: 'APPROVE' });
            tick(DAY / 2);
            for (const t of (await mockProvider.pendingTransfers()).filter((x) => x.status === 'SUBMITTED'))
                await mockProvider.simulateTransferOutcome(t.reference, 'PAID');
        }

        async function shippingEvidence(txId: string, bol: { vin: string; consignee: string; port: string }, declaredMinorAmount: string) {
            tick(DAY * 5);
            const view = await app.views.transaction(seller, txId);
            const m2 = view.milestones[1]!;
            await app.documents.upload(
                seller,
                {
                    transactionId: txId,
                    type: 'BILL_OF_LADING',
                    title: 'Connaissement maritime (B/L)',
                    milestoneId: m2.id,
                    extracted: {
                        vin: bol.vin,
                        consignee: bol.consignee,
                        portOfLoading: 'Montréal',
                        portOfDischarge: bol.port,
                        documentNumber: 'BL-DEMO-MTL-DKR-0042'
                    }
                },
                pdf('Connaissement maritime', [`VIN: ${bol.vin}`, `Destinataire: ${bol.consignee}`, `Port de dechargement: ${bol.port}`])
            );
            await app.documents.upload(
                seller,
                {
                    transactionId: txId,
                    type: 'EXPORT_DECLARATION',
                    title: 'Déclaration d’exportation',
                    milestoneId: m2.id,
                    extracted: { vin: bol.vin, amount: declaredMinorAmount, amountCurrency: 'CAD' }
                },
                pdf('Declaration exportation', [`VIN: ${bol.vin}`, `Valeur declaree: ${declaredMinorAmount} CAD`])
            );
            tick(DAY / 2);
            await app.milestones.submit(seller, txId, m2.id, 'Véhicule embarqué — connaissement et déclaration d’exportation joints.');
        }

        // 5 — Completed (history & statistics)
        clock.freeze(new Date(start - 40 * DAY));
        const highlander = await createAgreed(
            {
                make: 'Toyota',
                model: 'Highlander',
                year: 2019,
                vin: '5TDJZRFH4KS000417',
                mileageKm: 88_400,
                color: 'Gris',
                amount: '21750'
            },
            false
        );
        await fund(highlander);
        await completeFirstMilestone(highlander, '5TDJZRFH4KS000417');
        await shippingEvidence(highlander, { vin: '5TDJZRFH4KS000417', consignee: 'Awa Ndiaye', port: 'Dakar' }, '21750');
        tick(DAY);
        let hv = await app.views.transaction(seller, highlander);
        await app.milestones.review(buyer, highlander, hv.milestones[1]!.id, { decision: 'APPROVE' });
        for (const t of (await mockProvider.pendingTransfers()).filter((x) => x.status === 'SUBMITTED'))
            await mockProvider.simulateTransferOutcome(t.reference, 'PAID');
        tick(DAY * 20);
        hv = await app.views.transaction(seller, highlander);
        await app.documents.upload(
            buyer,
            { transactionId: highlander, type: 'DELIVERY_PROOF', title: 'Bon de livraison — port de Dakar', milestoneId: undefined },
            pdf('Bon de livraison', ['Vehicule remis a l acheteur au port de Dakar'])
        );
        hv = await app.views.transaction(seller, highlander);
        const proof = hv.documents.find((d) => d.type === 'DELIVERY_PROOF')!;
        await app.milestones.attachEvidence(seller, highlander, hv.milestones[2]!.id, proof.id);
        await app.milestones.submit(seller, highlander, hv.milestones[2]!.id, 'Véhicule livré.');
        await app.milestones.review(buyer, highlander, hv.milestones[2]!.id, { decision: 'APPROVE' });
        for (const t of (await mockProvider.pendingTransfers()).filter((x) => x.status === 'SUBMITTED'))
            await mockProvider.simulateTransferOutcome(t.reference, 'PAID');

        // 4 — Disputed: shipping documents inconsistent with the vehicle (VIN typo, other consignee)
        clock.freeze(new Date(start - 12 * DAY));
        const lexusVin = '2T2BZMCAXLC000233';
        const lexus = await createAgreed(
            { make: 'Lexus', model: 'RX 350', year: 2020, vin: lexusVin, mileageKm: 54_900, color: 'Blanc nacré', amount: '27900' },
            false
        );
        await fund(lexus);
        await completeFirstMilestone(lexus, lexusVin);
        await shippingEvidence(lexus, { vin: '2T2BZMCAXLC000283', consignee: 'Moussa Diallo', port: 'Dakar' }, '19500');
        tick(DAY);
        await app.disputes.open(buyer, lexus, {
            reason: 'SUSPICIOUS_DOCUMENTS',
            description:
                'Le VIN indiqué sur le connaissement ne correspond pas au véhicule acheté et le destinataire n’est pas moi. La valeur déclarée à l’exportation est aussi différente du prix.',
            requestedOutcome: 'Correction des documents par le transporteur ou remboursement des montants non versés.'
        });
        tick(DAY / 2);
        const lexusView = await app.views.transaction(seller, lexus);
        await app.disputes.addMessage(seller, lexusView.disputes[0]!.id, {
            body: 'Erreur de saisie du transitaire sur le connaissement. Nous avons demandé un connaissement corrigé à la compagnie maritime.',
            documentIds: []
        });

        // 1 — Main scenario: milestone 2 awaiting the buyer's review
        clock.freeze(new Date(start + 10 * DAY));
        const rav4Vin = '2T3W1RFV7MC123456';
        const rav4 = await createAgreed(
            { make: 'Toyota', model: 'RAV4', year: 2021, vin: rav4Vin, mileageKm: 62_300, color: 'Bleu cavalier', amount: '18500' },
            true
        );
        await fund(rav4);
        await completeFirstMilestone(rav4, rav4Vin);
        tick(DAY);
        const forwarderInvite = await app.deps.uow.run(async (db) => {
            const now = clock.now().toISOString();
            const party = {
                id: app.deps.ids.id(),
                transactionId: rav4,
                role: 'FREIGHT_FORWARDER' as const,
                displayName: 'Transit Atlantique SARL',
                email: 'ibrahima.sarr@demo.trustcargo.test',
                status: 'INVITED' as const,
                createdAt: now
            };
            await db.transactionParties.insert(party);
            return party.id;
        });
        const link = await app.transactions.regenerateInvitation(seller, rav4, forwarderInvite);
        await app.transactions.acceptInvitation(forwarder, link.url.split('/invite/')[1]!);
        await shippingEvidence(rav4, { vin: rav4Vin, consignee: 'Awa Ndiaye', port: 'Port autonome de Dakar' }, '18500');

        // 2 — Agreed, awaiting the buyer's (simulated) payment
        clock.freeze(new Date(start + 33 * DAY));
        await createAgreed(
            { make: 'Honda', model: 'CR-V', year: 2019, vin: '2HKRW2H82KH000731', mileageKm: 97_800, color: 'Noir', amount: '14200' },
            false
        );

        // 3 — Invitation pending for a business buyer who has not verified their identity yet
        clock.freeze(new Date(start + 36 * DAY));
        const corolla = await app.transactions.createVehicleTransaction(
            seller,
            vehicleInput(
                {
                    make: 'Toyota',
                    model: 'Corolla',
                    year: 2020,
                    vin: '2T1BURHE1LC000519',
                    mileageKm: 71_000,
                    color: 'Argent',
                    amount: '9800'
                },
                { fullName: 'Cheikh Fall', email: 'cheikh.fall@demo.trustcargo.test' },
                dealerOrg
            )
        );
        await app.documents.upload(
            seller,
            {
                transactionId: corolla.id,
                type: 'TITLE',
                title: 'Certificat d’immatriculation (titre)',
                extracted: { vin: '2T1BURHE1LC000519', ownerName: 'Autos Saint-Laurent Export inc.' }
            },
            pdf('Certificat immatriculation', ['VIN: 2T1BURHE1LC000519'])
        );
        await app.documents.upload(
            seller,
            { transactionId: corolla.id, type: 'INVOICE', title: 'Facture de vente', extracted: { amount: '9800', amountCurrency: 'CAD' } },
            pdf('Facture de vente', ['Montant: 9800 CAD'])
        );
        await app.transactions.sendInvitations(seller, corolla.id);
        void buyer2;
        void refresh;
    } finally {
        clock.unfreeze();
    }
}
