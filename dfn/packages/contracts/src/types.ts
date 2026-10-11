export interface ContractParty {
  role: 'BUYER' | 'SELLER';
  displayName: string;
  email: string;
  country?: string;
}

export interface ContractMilestoneTerm {
  sequence: number;
  title: string;
  description?: string;
  amount: string; // decimal string
  requiredEvidence: string[];
}

export interface ProtectContractTerms {
  transactionReference: string;
  title: string;
  description: string;
  category: string;
  currencyCode: string;
  totalAmount: string; // decimal string
  platformFee: string; // decimal string
  originCountry: string;
  destinationCountry: string;
  deliveryDeadlineDays: number;
  inspectionWindowDays: number;
  governingLaw: string;
  additionalClauses?: string;
  parties: ContractParty[];
  milestones: ContractMilestoneTerm[];
}

export interface RenderedContract {
  templateCode: string;
  templateVersion: string;
  locale: 'fr' | 'en';
  bodyText: string;
  contentHash: string;
}
