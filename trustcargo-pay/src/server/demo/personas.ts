import type { PlatformRole } from '@/domain/model';

/**
 * Fictitious demo personas. Names are invented; emails use the reserved `.test` TLD so they can
 * never reach a real mailbox. No real personal data is used anywhere in the demo.
 */
export interface Persona {
    key: string;
    email: string;
    fullName: string;
    country: string;
    city: string;
    locale: 'fr' | 'en';
    platformRoles: PlatformRole[];
    kyc: 'VERIFIED' | 'NOT_STARTED';
    headline: { fr: string; en: string };
}

export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

export const PERSONAS: Persona[] = [
    {
        key: 'seller',
        email: 'julien.tremblay@demo.trustcargo.test',
        fullName: 'Julien Tremblay',
        country: 'CA',
        city: 'Montréal',
        locale: 'fr',
        platformRoles: [],
        kyc: 'VERIFIED',
        headline: { fr: 'Vendeur — Autos Saint-Laurent Export (Montréal)', en: 'Seller — Autos Saint-Laurent Export (Montreal)' }
    },
    {
        key: 'buyer',
        email: 'awa.ndiaye@demo.trustcargo.test',
        fullName: 'Awa Ndiaye',
        country: 'SN',
        city: 'Dakar',
        locale: 'fr',
        platformRoles: [],
        kyc: 'VERIFIED',
        headline: { fr: 'Acheteuse particulière (Dakar)', en: 'Individual buyer (Dakar)' }
    },
    {
        key: 'buyer2',
        email: 'cheikh.fall@demo.trustcargo.test',
        fullName: 'Cheikh Fall',
        country: 'SN',
        city: 'Thiès',
        locale: 'fr',
        platformRoles: [],
        kyc: 'NOT_STARTED',
        headline: { fr: 'Acheteur professionnel — identité non vérifiée', en: 'Business buyer — identity not verified' }
    },
    {
        key: 'inspector',
        email: 'marie-eve.gagnon@demo.trustcargo.test',
        fullName: 'Marie-Ève Gagnon',
        country: 'CA',
        city: 'Longueuil',
        locale: 'fr',
        platformRoles: [],
        kyc: 'VERIFIED',
        headline: { fr: 'Inspectrice indépendante', en: 'Independent inspector' }
    },
    {
        key: 'forwarder',
        email: 'ibrahima.sarr@demo.trustcargo.test',
        fullName: 'Ibrahima Sarr',
        country: 'SN',
        city: 'Dakar',
        locale: 'fr',
        platformRoles: [],
        kyc: 'VERIFIED',
        headline: { fr: 'Transitaire — Transit Atlantique', en: 'Freight forwarder — Transit Atlantique' }
    },
    {
        key: 'compliance',
        email: 'sophie.martin@demo.trustcargo.test',
        fullName: 'Sophie Martin',
        country: 'CA',
        city: 'Montréal',
        locale: 'fr',
        platformRoles: ['compliance_analyst'],
        kyc: 'VERIFIED',
        headline: { fr: 'Analyste conformité', en: 'Compliance analyst' }
    },
    {
        key: 'reviewer',
        email: 'thomas.roy@demo.trustcargo.test',
        fullName: 'Thomas Roy',
        country: 'CA',
        city: 'Québec',
        locale: 'fr',
        platformRoles: ['document_reviewer', 'compliance_analyst'],
        kyc: 'VERIFIED',
        headline: { fr: 'Contrôle documentaire + conformité', en: 'Document review + compliance' }
    },
    {
        key: 'disputes',
        email: 'karim.benali@demo.trustcargo.test',
        fullName: 'Karim Benali',
        country: 'CA',
        city: 'Montréal',
        locale: 'fr',
        platformRoles: ['dispute_manager'],
        kyc: 'VERIFIED',
        headline: { fr: 'Gestionnaire des litiges', en: 'Dispute manager' }
    },
    {
        key: 'finance',
        email: 'lea.bouchard@demo.trustcargo.test',
        fullName: 'Léa Bouchard',
        country: 'CA',
        city: 'Montréal',
        locale: 'fr',
        platformRoles: ['finance_operator'],
        kyc: 'VERIFIED',
        headline: { fr: 'Opérations financières & réconciliation', en: 'Finance operations & reconciliation' }
    },
    {
        key: 'admin',
        email: 'nadia.haddad@demo.trustcargo.test',
        fullName: 'Nadia Haddad',
        country: 'CA',
        city: 'Montréal',
        locale: 'fr',
        platformRoles: ['platform_admin'],
        kyc: 'VERIFIED',
        headline: { fr: 'Administratrice plateforme (configuration)', en: 'Platform administrator (configuration)' }
    },
    {
        key: 'auditor',
        email: 'paul.lefebvre@demo.trustcargo.test',
        fullName: 'Paul Lefebvre',
        country: 'CA',
        city: 'Ottawa',
        locale: 'fr',
        platformRoles: ['auditor'],
        kyc: 'VERIFIED',
        headline: { fr: 'Auditeur (lecture seule)', en: 'Auditor (read-only)' }
    }
];
