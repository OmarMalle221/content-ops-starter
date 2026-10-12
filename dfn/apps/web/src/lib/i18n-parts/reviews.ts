import { definePart } from './define';

/** Phase 6 — compliance review queues. Only the `reviewQueue` namespace lives here; FR defines the shape, EN mirrors it. */
export const reviewQueuePart = definePart(
  {
    reviewQueue: {
      title: 'File de revue conformité',
      description:
        'Alertes de risque explicables, consultatives : aucune décision automatique. Chaque décision exige une note motivée.',
      export: 'Exporter (CSV)',
      exportHint: 'Exporte la file filtrée (données fictives, cellules protégées contre les formules)',
      results: 'alerte(s)',
      empty: 'Aucune alerte ne correspond à ces filtres.',
      rules: 'Règles actives',
      rulesHint: 'Moteur explicable : chaque alerte détaille les faits qui l’ont déclenchée.',
      /**
       * Risk-rule texts (packages/compliance/src/risk/rules.ts, English only). Only static strings:
       * riskRuleText() swaps a server text for its translation when it equals the English entry
       * below; texts with figures (velocity, ratios…) are shown as sent.
       */
      ruleTexts: {
        AMOUNT_VS_PROFILE: {
          description:
            'Montant de la transaction disproportionné par rapport à l’historique de l’organisation',
          recommendation:
            'Confirmer la justification commerciale et les pièces justificatives avant toute libération.',
        },
        VELOCITY_24H: {
          description: 'Nombre inhabituel de transactions créées en 24 heures',
          recommendation:
            'Rechercher un fractionnement ou une prise de contrôle du compte ; contacter l’organisation si nécessaire.',
        },
        UNVERIFIED_HIGH_VALUE: {
          description:
            'Transaction de montant élevé alors que la vérification d’identité ou d’entreprise est incomplète',
          summary:
            'Transaction de montant élevé créée par une partie dont la vérification d’identité est incomplète',
          recommendation: 'Exiger la vérification d’identité avant d’accepter le financement.',
        },
        REPEATED_LOGIN_FAILURES: {
          description: 'Échecs de connexion répétés',
          recommendation:
            'Le compte est temporairement verrouillé ; vérifier l’identité du titulaire avant de le déverrouiller.',
        },
        MULTI_DISPUTE_ACCOUNT: {
          description: 'Compte associé à plusieurs litiges',
          recommendation: 'Examiner l’historique des litiges avant d’approuver d’autres libérations.',
        },
        GEOGRAPHY_MISMATCH: {
          description:
            'Pays de l’acheteur incohérent avec l’origine de la transaction, ou corridor non pris en charge',
          summary: 'Le pays déclaré par l’utilisateur diffère du pays d’origine de la transaction',
          summaryUnsupported: 'Corridor pas encore pris en charge',
          recommendation: 'Confirmer la résidence de l’acheteur et l’éligibilité du corridor.',
        },
        DOCUMENT_REUSE: {
          description: 'Empreinte de document identique déjà téléversée sur d’autres transactions',
          recommendation: 'Vérifier que la preuve est authentique et propre à cette transaction.',
        },
        NEW_ACCOUNT_HIGH_VALUE: {
          description: 'Compte très récent créant une transaction de montant élevé',
          summary: 'Un compte de moins de 3 jours a créé une transaction de montant élevé',
          recommendation: 'Surveiller ; demander la vérification avant le financement.',
        },
        TRANSFER_VELOCITY: {
          description: 'Nombre inhabituel de transferts initiés par l’organisation en 24 heures',
          recommendation:
            'Rechercher un fractionnement (schtroumpfage) ou une prise de contrôle du compte avant le règlement d’autres transferts.',
        },
        NEW_BENEFICIARY_HIGH_VALUE: {
          description: 'Transfert important vers un bénéficiaire ajouté il y a moins de 24 heures',
          summary: 'Transfert de montant élevé vers un bénéficiaire enregistré il y a moins de 24 heures',
          recommendation:
            'Confirmer le bénéficiaire auprès de l’expéditeur par un second canal avant le règlement.',
        },
        BENEFICIARY_CHURN: {
          description: 'Nombreux bénéficiaires ajoutés ou supprimés en 24 heures',
          recommendation:
            'Possible prise de contrôle du compte : vérifier les connexions récentes et contacter l’organisation.',
        },
        UNVERIFIED_TRANSFER: {
          description:
            'Transfert de montant élevé autorisé alors que la vérification d’identité est incomplète',
          summary:
            'Transfert de montant élevé autorisé par un utilisateur dont la vérification d’identité est incomplète',
          recommendation: 'Retenir le transfert pour revue manuelle et exiger la vérification d’identité.',
        },
        TRANSFER_DRAINS_WALLET: {
          description: 'Transfert qui vide (presque) tout le solde du portefeuille',
          summary: 'Le montant du transfert atteint au moins 90 % du solde du portefeuille',
          recommendation:
            'Surveiller ; combiné à d’autres signaux, cela peut indiquer une escroquerie de sortie ou une prise de contrôle.',
        },
        STRUCTURING: {
          description:
            'Plusieurs opérations, chacune sous le seuil agrégé, dont la somme l’atteint dans la fenêtre glissante (même utilisateur ou organisation, même devise et même sens)',
          recommendation:
            'Examiner les opérations ensemble (objet, origine des fonds, liens entre elles). Ne pas informer le client d’une éventuelle déclaration (interdiction de divulgation) ; transmettre au responsable de la conformité si le soupçon est raisonnable.',
        },
        SANCTIONS_POTENTIAL_MATCH: {
          summary: 'Correspondance potentielle avec une liste de sanctions (criblage simulé)',
          recommendation: 'Revue de conformité manuelle avant tout financement.',
        },
      },
      stats: {
        open: 'Ouvertes',
        overdue: 'En retard',
        unassigned: 'Non assignées',
        mine: 'Assignées à moi',
        breached: 'SLA dépassé (notifié)',
        medianFirstAction: 'Délai médian de 1re action',
        medianHint: '30 derniers jours · {n} alerte(s)',
        none: '—',
        slaHint: 'SLA : élevée {high} h · moyenne {medium} h · faible {low} h',
      },
      filters: {
        view: 'Vue',
        viewOpen: 'À traiter',
        viewClosed: 'Décidées',
        viewAll: 'Toutes',
        severity: 'Gravité',
        allSeverities: 'Toutes gravités',
        rule: 'Règle',
        allRules: 'Toutes les règles',
        assignee: 'Assignation',
        anyAssignee: 'Tout le monde',
        me: 'Moi',
        unassigned: 'Non assignées',
        overdueOnly: 'En retard uniquement',
        from: 'Créées du',
        to: 'au',
        sort: 'Tri',
        reset: 'Réinitialiser',
      },
      sorts: {
        dueAt: 'Échéance la plus proche',
        '-dueAt': 'Échéance la plus lointaine',
        createdAt: 'Plus anciennes',
        '-createdAt': 'Plus récentes',
        severity: 'Gravité',
      },
      severity: { HIGH: 'Élevée', MEDIUM: 'Moyenne', LOW: 'Faible' },
      sla: {
        dueIn: 'Échéance dans {d}',
        overdueBy: 'En retard de {d}',
        breached: 'SLA dépassé',
        decided: 'Décidée',
        dueAt: 'Échéance',
      },
      units: { d: 'j', h: 'h', min: 'min' },
      assign: {
        assignee: 'Assignée à',
        nobody: 'Personne',
        assignToMe: 'M’assigner',
        reassign: 'Réassigner…',
        unassign: 'Retirer l’assignation',
        since: 'depuis le',
      },
      item: {
        created: 'Créée le',
        age: 'Âge',
        score: 'Score',
        subject: 'Personne',
        organization: 'Organisation',
        transaction: 'Transaction',
        firstAction: '1re action',
        history: 'Historique',
        resolvedBy: 'Décision par',
        operations: 'Opérations agrégées',
        repeated: '{n} détection(s) ultérieure(s) dans la fenêtre',
        noNote: '—',
      },
      actionNames: {
        ASSIGN: 'Assignation',
        UNASSIGN: 'Désassignation',
        START_REVIEW: 'Revue démarrée',
        CONFIRM: 'Anomalie confirmée',
        DISMISS: 'Écartée',
        CONTEST: 'Contestation',
      },
      noteHint: 'Note obligatoire (3 caractères minimum) : elle est conservée dans l’historique et l’audit.',
      pagination: { previous: 'Précédent', next: 'Suivant', page: 'Page {page} / {pages}' },
    },
  },
  {
    reviewQueue: {
      title: 'Compliance review queue',
      description:
        'Explainable, advisory risk alerts: no automatic decision. Every decision requires a reasoned note.',
      export: 'Export (CSV)',
      exportHint: 'Exports the filtered queue (simulated data, cells protected against formulas)',
      results: 'alert(s)',
      empty: 'No alert matches these filters.',
      rules: 'Active rules',
      rulesHint: 'Explainable engine: every alert details the facts that triggered it.',
      ruleTexts: {
        AMOUNT_VS_PROFILE: {
          description: 'Transaction amount disproportionate to the organisation history',
          recommendation: 'Confirm the commercial rationale and supporting documents before release.',
        },
        VELOCITY_24H: {
          description: 'Unusual number of transactions created in 24 hours',
          recommendation: 'Check for structuring or account takeover; contact the organisation if needed.',
        },
        UNVERIFIED_HIGH_VALUE: {
          description: 'High-value transaction while identity/business verification is not complete',
          summary: 'High-value transaction created by a party whose identity verification is incomplete',
          recommendation: 'Require identity verification before funding is accepted.',
        },
        REPEATED_LOGIN_FAILURES: {
          description: 'Repeated failed sign-in attempts',
          recommendation: 'Account is temporarily locked; verify ownership before unlocking.',
        },
        MULTI_DISPUTE_ACCOUNT: {
          description: 'Account associated with several disputes',
          recommendation: 'Review dispute history before approving further releases.',
        },
        GEOGRAPHY_MISMATCH: {
          description: 'Buyer country inconsistent with transaction origin or unsupported corridor',
          summary: 'Declared user country differs from the transaction origin country',
          summaryUnsupported: 'Corridor is not yet supported',
          recommendation: 'Confirm the residency of the buyer and the corridor eligibility.',
        },
        DOCUMENT_REUSE: {
          description: 'Identical document hash already uploaded on other transactions',
          recommendation: 'Verify that the proof is genuine and specific to this transaction.',
        },
        NEW_ACCOUNT_HIGH_VALUE: {
          description: 'Very recent account creating a high-value transaction',
          summary: 'Account younger than 3 days created a high-value transaction',
          recommendation: 'Monitor; request verification before funding.',
        },
        TRANSFER_VELOCITY: {
          description: 'Unusual number of transfers initiated by the organisation in 24 hours',
          recommendation:
            'Check for structuring (smurfing) or account takeover before further transfers settle.',
        },
        NEW_BENEFICIARY_HIGH_VALUE: {
          description: 'Large transfer to a beneficiary added less than 24 hours ago',
          summary: 'High-value transfer to a beneficiary registered less than 24 hours ago',
          recommendation:
            'Confirm the beneficiary with the sender through a second channel before settlement.',
        },
        BENEFICIARY_CHURN: {
          description: 'Many beneficiaries added or removed within 24 hours',
          recommendation: 'Possible account takeover: verify recent sign-ins and contact the organisation.',
        },
        UNVERIFIED_TRANSFER: {
          description: 'High-value transfer authorised while identity verification is incomplete',
          summary: 'High-value transfer authorised by a user whose identity verification is incomplete',
          recommendation: 'Hold the transfer for manual review and require identity verification.',
        },
        TRANSFER_DRAINS_WALLET: {
          description: 'Transfer that empties (almost) the whole wallet balance',
          summary: 'Transfer amount is at least 90 % of the wallet balance',
          recommendation: 'Monitor; combined with other signals this may indicate an exit scam or takeover.',
        },
        STRUCTURING: {
          description:
            'Several operations each below the aggregate threshold whose sum reaches it within the rolling window (same user or organisation, same currency and direction)',
          recommendation:
            'Review the operations together (purpose, source of funds, links between them). Do not inform the customer of a possible report (tipping-off); escalate to the compliance officer if suspicion is reasonable.',
        },
        SANCTIONS_POTENTIAL_MATCH: {
          summary: 'Potential sanctions list match (simulated screening)',
          recommendation: 'Manual compliance review before any funding.',
        },
      },
      stats: {
        open: 'Open',
        overdue: 'Overdue',
        unassigned: 'Unassigned',
        mine: 'Assigned to me',
        breached: 'SLA breached (notified)',
        medianFirstAction: 'Median time to first action',
        medianHint: 'Last 30 days · {n} alert(s)',
        none: '—',
        slaHint: 'SLA: high {high} h · medium {medium} h · low {low} h',
      },
      filters: {
        view: 'View',
        viewOpen: 'To review',
        viewClosed: 'Decided',
        viewAll: 'All',
        severity: 'Severity',
        allSeverities: 'All severities',
        rule: 'Rule',
        allRules: 'All rules',
        assignee: 'Assignment',
        anyAssignee: 'Anyone',
        me: 'Me',
        unassigned: 'Unassigned',
        overdueOnly: 'Overdue only',
        from: 'Created from',
        to: 'to',
        sort: 'Sort',
        reset: 'Reset',
      },
      sorts: {
        dueAt: 'Nearest deadline',
        '-dueAt': 'Furthest deadline',
        createdAt: 'Oldest',
        '-createdAt': 'Newest',
        severity: 'Severity',
      },
      severity: { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' },
      sla: {
        dueIn: 'Due in {d}',
        overdueBy: 'Overdue by {d}',
        breached: 'SLA breached',
        decided: 'Decided',
        dueAt: 'Deadline',
      },
      units: { d: 'd', h: 'h', min: 'min' },
      assign: {
        assignee: 'Assigned to',
        nobody: 'Nobody',
        assignToMe: 'Assign to me',
        reassign: 'Reassign…',
        unassign: 'Remove assignment',
        since: 'since',
      },
      item: {
        created: 'Created',
        age: 'Age',
        score: 'Score',
        subject: 'Person',
        organization: 'Organisation',
        transaction: 'Transaction',
        firstAction: 'First action',
        history: 'History',
        resolvedBy: 'Decided by',
        operations: 'Aggregated operations',
        repeated: '{n} later detection(s) in the window',
        noNote: '—',
      },
      actionNames: {
        ASSIGN: 'Assigned',
        UNASSIGN: 'Unassigned',
        START_REVIEW: 'Review started',
        CONFIRM: 'Anomaly confirmed',
        DISMISS: 'Dismissed',
        CONTEST: 'Contested',
      },
      noteHint: 'A note is required (3 characters minimum): it is kept in the history and the audit trail.',
      pagination: { previous: 'Previous', next: 'Next', page: 'Page {page} / {pages}' },
    },
  },
);
