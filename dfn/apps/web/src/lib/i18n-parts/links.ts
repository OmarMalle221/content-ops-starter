import { definePart } from './define';

/** Phase 6 — counterparty link consent. Only the `counterpartyLinks` namespace lives here; FR defines the shape, EN mirrors it. */
export const counterpartyLinksPart = definePart(
  {
    counterpartyLinks: {
      title: 'Liaisons clients',
      subtitle:
        'Organisations qui souhaitent vous relier comme client. Tant que vous n’acceptez pas, leurs factures et devis ne vous sont ni visibles ni payables.',
      column: 'Liaison DFN',
      status: {
        NONE: 'Aucun lien',
        REQUESTED: 'Demande envoyée si un compte correspond',
        ACCEPTED: 'Lié',
        DECLINED: 'Refusé',
        REVOKED: 'Révoqué',
      },
      requestedOn: 'Demandée le',
      decidedOn: 'Décidée le',
      linkedTo: 'Lié à',
      requestAgainAfter: 'Nouvelle demande possible après le',
      revoke: 'Révoquer',
      revokeTitle: 'Révoquer la liaison ou la demande',
      revokeHint:
        'Le client ne verra plus vos factures et devis et ne pourra plus les payer depuis son portefeuille. Une nouvelle demande sera possible après 24 h.',
      reason: 'Motif (facultatif)',
      requestAgain: 'Renvoyer la demande',
      requestAgainHint:
        'Une demande de liaison est envoyée si un compte Diaspora Trust correspond à l’adresse du client ; il devra l’accepter.',
      consentHint:
        'Une liaison n’est active qu’après acceptation par le client. Nous n’indiquons jamais si une adresse correspond à un compte.',
      createdNotice:
        'Fiche client créée. Si l’adresse correspond à un compte Diaspora Trust, une demande de liaison lui a été envoyée.',
      received: 'Demandes de liaison reçues',
      receivedHint: 'Acceptez uniquement les organisations que vous connaissez.',
      noRequests: 'Aucune demande en attente',
      noRequestsHint: 'Les organisations qui souhaitent vous relier comme client apparaîtront ici.',
      requester: 'Organisation',
      orgTypes: { BUSINESS: 'Entreprise', PERSONAL: 'Particulier' },
      enteredAs: 'Nom saisi par l’organisation',
      date: 'Date',
      actions: 'Actions',
      accept: 'Accepter',
      acceptHint:
        'Vous verrez les factures et devis que cette organisation vous adresse et pourrez les payer depuis votre portefeuille sandbox (montants fictifs).',
      decline: 'Refuser',
      declineHint:
        'L’organisation verra que la demande a été refusée et ne pourra la renouveler qu’après 24 h.',
      note: 'Note (facultative)',
      endLink: 'Mettre fin à la liaison',
      endLinkHint:
        'Les factures et devis de cette organisation ne vous seront plus visibles ni payables. Elle pourra vous adresser une nouvelle demande après 24 h.',
      active: 'Liaisons actives',
      activeHint:
        'Organisations dont vous avez accepté la liaison : leurs factures apparaissent dans « Reçues ».',
      noActive: 'Aucune liaison active.',
      noAccess: 'Réservé aux propriétaires et administrateurs',
      noAccessHint:
        'Seuls les propriétaires et administrateurs de l’organisation peuvent accepter ou refuser une liaison.',
      pending: 'demande(s) de liaison en attente',
      review: 'Examiner',
    },
  },
  {
    counterpartyLinks: {
      title: 'Client links',
      subtitle:
        'Organisations that want to link you as a client. Until you accept, their invoices and quotes are neither visible nor payable for you.',
      column: 'DFN link',
      status: {
        NONE: 'No link',
        REQUESTED: 'Request sent if an account matches',
        ACCEPTED: 'Linked',
        DECLINED: 'Declined',
        REVOKED: 'Revoked',
      },
      requestedOn: 'Requested on',
      decidedOn: 'Decided on',
      linkedTo: 'Linked to',
      requestAgainAfter: 'New request possible after',
      revoke: 'Revoke',
      revokeTitle: 'Revoke the link or the request',
      revokeHint:
        'The client will no longer see your invoices and quotes nor pay them from its wallet. A new request is possible after 24 h.',
      reason: 'Reason (optional)',
      requestAgain: 'Send the request again',
      requestAgainHint:
        'A link request is sent if a Diaspora Trust account matches the client’s address; they will have to accept it.',
      consentHint:
        'A link only becomes active once the client accepts it. We never disclose whether an address matches an account.',
      createdNotice:
        'Client record created. If the address matches a Diaspora Trust account, a link request was sent to it.',
      received: 'Link requests received',
      receivedHint: 'Only accept organisations you know.',
      noRequests: 'No pending request',
      noRequestsHint: 'Organisations that want to link you as a client will appear here.',
      requester: 'Organisation',
      orgTypes: { BUSINESS: 'Business', PERSONAL: 'Individual' },
      enteredAs: 'Name entered by the organisation',
      date: 'Date',
      actions: 'Actions',
      accept: 'Accept',
      acceptHint:
        'You will see the invoices and quotes this organisation sends you and can pay them from your sandbox wallet (fictitious amounts).',
      decline: 'Decline',
      declineHint:
        'The organisation will see that the request was declined and can only renew it after 24 h.',
      note: 'Note (optional)',
      endLink: 'End the link',
      endLinkHint:
        'Invoices and quotes from this organisation will no longer be visible or payable. It can send you a new request after 24 h.',
      active: 'Active links',
      activeHint: 'Organisations whose link you accepted: their invoices appear under “Received”.',
      noActive: 'No active link.',
      noAccess: 'Owners and administrators only',
      noAccessHint: 'Only owners and administrators of the organisation can accept or decline a link.',
      pending: 'pending link request(s)',
      review: 'Review',
    },
  },
);
