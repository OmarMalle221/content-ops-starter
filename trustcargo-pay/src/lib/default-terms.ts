import type { Locale, MilestoneTerm } from '@/domain/model';

/** Example contract wording pre-filled in the wizard. Parties must review and adapt it. */
export function defaultTerms(
    locale: Locale,
    v: { make: string; model: string; year: string | number; vin: string; mileageKm: string | number }
) {
    const label = `${v.make} ${v.model} ${v.year}`.trim();
    if (locale === 'en') {
        return {
            goodsDescription: `${label}, VIN ${v.vin}, ${v.mileageKm} km, sold in the condition described in the inspection report.`,
            sellerResponsibilities:
                'Provide the title, invoice, independent inspection report, bill of lading and export declaration. Deliver the vehicle to the port of Montreal.',
            buyerResponsibilities:
                'Send funds to the financial partner per its instructions. Review evidence within the agreed deadlines. Handle customs clearance in Dakar.',
            inspectionTerms: 'Independent pre-shipment inspection (mechanical, body, VIN match). The report is shared with both parties.',
            shippingTerms: 'CFR Dakar (Incoterms® 2020) — ro-ro shipping from the port of Montreal.',
            deliveryTerms: 'Vehicle handed over to the buyer at the port of Dakar after customs clearance.',
            releaseTerms:
                'Each payout requires the buyer’s explicit approval or a dispute decision, then an authorised instruction executed by the financial partner.',
            refundTerms: 'Refund of unpaid amounts if the vehicle is not shipped on time or if non-conformity is established.',
            disputeProcedure:
                'Reasoned dispute filing, adversarial response within 7 days, review and decision by an authorised person under this contract.',
            deadlines: { inspectionDays: 7, shippingDays: 21, deliveryDays: 45, reviewDays: 7 }
        };
    }
    return {
        goodsDescription: `${label}, VIN ${v.vin}, ${v.mileageKm} km, vendu en l’état décrit dans le rapport d’inspection.`,
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
    };
}

export function defaultMilestones(locale: Locale): MilestoneTerm[] {
    const fr = locale === 'fr';
    return [
        {
            key: 'initial-checks',
            title: fr ? 'Vérifications initiales' : 'Initial checks',
            description: fr
                ? 'Inspection indépendante du véhicule et contrôle des documents de propriété.'
                : 'Independent vehicle inspection and ownership document checks.',
            shareBps: 1000,
            requiredEvidence: ['INSPECTION_REPORT', 'TITLE']
        },
        {
            key: 'shipping',
            title: fr ? 'Preuve d’expédition' : 'Proof of shipment',
            description: fr
                ? 'Connaissement maritime et déclaration d’exportation conformes.'
                : 'Compliant bill of lading and export declaration.',
            shareBps: 4000,
            requiredEvidence: ['BILL_OF_LADING', 'EXPORT_DECLARATION']
        },
        {
            key: 'final-acceptance',
            title: fr ? 'Validation finale' : 'Final acceptance',
            description: fr
                ? 'Réception du véhicule à destination et validation par l’acheteur.'
                : 'Vehicle received at destination and approved by the buyer.',
            shareBps: 5000,
            requiredEvidence: ['DELIVERY_PROOF']
        }
    ];
}
