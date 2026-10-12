import { definePart } from './define';

/** Phase 6 — passkeys & MFA. Only the `passkeys` namespace lives here; FR defines the shape, EN mirrors it. */
export const passkeysPart = definePart(
  {
    passkeys: {
      title: 'Clés d’accès',
      description:
        'Connectez-vous sans mot de passe avec la biométrie ou le code de votre appareil. Une clé d’accès résiste à l’hameçonnage et vaut double authentification.',
      sandboxNote: 'Bac à sable : la clé d’accès est réelle côté appareil, mais protège un compte fictif.',
      loginWith: 'Se connecter avec une clé d’accès',
      loginHint: 'Utilise une clé d’accès enregistrée sur cet appareil ou sur un téléphone à proximité.',
      or: 'ou',
      checking: 'Vérification de la prise en charge des clés d’accès…',
      unsupported:
        'Ce navigateur ne prend pas en charge les clés d’accès (WebAuthn). Utilisez votre mot de passe et votre code de vérification.',
      cancelled: 'Opération annulée ou délai dépassé. Réessayez.',
      failed: 'La clé d’accès n’a pas pu être vérifiée. Réessayez.',
      add: 'Ajouter une clé d’accès',
      nameLabel: 'Nom de la clé',
      namePlaceholder: 'Ex. : iPhone de Fatou',
      added: 'Clé d’accès ajoutée.',
      addProofHint:
        'Par sécurité, confirmez votre mot de passe : une clé d’accès donne un accès durable à votre compte.',
      empty: 'Aucune clé d’accès enregistrée pour l’instant.',
      createdAt: 'Ajoutée le',
      lastUsed: 'Dernière utilisation',
      never: 'jamais',
      synced: 'Synchronisée',
      deviceBound: 'Liée à l’appareil',
      rename: 'Renommer',
      renamed: 'Clé renommée.',
      revoke: 'Révoquer',
      revokeTitle: 'Révoquer cette clé d’accès ?',
      revokeDescription:
        'Elle ne permettra plus de se connecter ni de confirmer une opération. Vous recevrez une notification.',
      revoked: 'Clé d’accès révoquée.',
      stepUp: {
        codeLabel: 'Code de vérification ou code de secours',
        codeHint: '6 chiffres de votre application d’authentification, ou un code de secours XXXX-XXXX-XX.',
        usePasskey: 'Confirmer avec une clé d’accès',
        required:
          'Cette modification réduit votre niveau de protection : confirmez-la avec un code ou une clé d’accès.',
      },
      mfa: {
        recoveryToggle: 'Utiliser un code de secours',
        totpToggle: 'Utiliser le code de l’application',
        recoveryLabel: 'Code de secours',
        recoveryHint: 'Format XXXX-XXXX-XX. Chaque code ne fonctionne qu’une seule fois.',
        usePasskey: 'Utiliser une clé d’accès',
        disableHint:
          'Pour désactiver, saisissez un code de l’application ou un code de secours, ou confirmez avec une clé d’accès.',
        enabledWithCodes: 'Double authentification activée. Conservez vos codes de secours ci-dessous.',
        /** Settings card (enable / disable TOTP): context wording, before `passkeys.errors`. */
        errors: {
          VALIDATION_FAILED:
            'Code invalide : vérifiez le code affiché par votre application d’authentification.',
        },
      },
      recovery: {
        title: 'Codes de secours',
        description:
          'Si vous perdez l’accès à votre application d’authentification, un code de secours remplace le code à 6 chiffres. Chaque code ne sert qu’une fois.',
        remaining: '{count} code(s) disponible(s) sur {total}',
        generatedAt: 'Générés le',
        low: 'Il vous reste peu de codes : pensez à les régénérer.',
        regenerate: 'Régénérer les codes',
        regenerateTitle: 'Régénérer les codes de secours ?',
        regenerateHint: 'Les anciens codes cesseront immédiatement de fonctionner.',
        showOnceTitle: 'Vos codes de secours',
        showOnce:
          'Conservez-les en lieu sûr (gestionnaire de mots de passe, papier) : ils ne seront plus jamais affichés.',
        copyAll: 'Copier les codes',
        done: 'J’ai conservé mes codes',
        mfaRequired: 'Activez d’abord la double authentification (TOTP) pour obtenir des codes de secours.',
      },
      transfer: {
        codeHint: 'Code à 6 chiffres de votre application, ou un code de secours.',
        usePasskey: 'Autoriser avec une clé d’accès',
      },
      /** API error codes (packages/shared/src/errors.ts) → interface wording; see localizedApiError. */
      errors: {
        MFA_REQUIRED: 'Code de vérification invalide ou manquant.',
        MFA_CODE_REUSED:
          'Ce code a déjà été utilisé. Attendez le code suivant de votre application d’authentification.',
        RECOVERY_CODE_INVALID: 'Ce code de secours est invalide ou a déjà été utilisé.',
        STEP_UP_REQUIRED:
          'Confirmation refusée : le code, la clé d’accès ou le mot de passe fourni est manquant ou invalide.',
        PASSKEY_VERIFICATION_FAILED: 'La clé d’accès n’a pas pu être vérifiée. Réessayez.',
        PASSKEY_NOT_FOUND: 'Clé d’accès introuvable ou déjà révoquée.',
        CHALLENGE_EXPIRED: 'La demande de clé d’accès a expiré ou a déjà servi. Recommencez.',
        ACCOUNT_LOCKED:
          'Trop de tentatives erronées : l’accès est temporairement bloqué. Réessayez plus tard.',
        RATE_LIMITED: 'Trop de tentatives rapprochées. Patientez un instant puis réessayez.',
      },
    },
  },
  {
    passkeys: {
      title: 'Passkeys',
      description:
        'Sign in without a password using your device biometrics or PIN. A passkey resists phishing and counts as two-factor authentication.',
      sandboxNote: 'Sandbox: the passkey is real on your device, but it protects a fictitious account.',
      loginWith: 'Sign in with a passkey',
      loginHint: 'Uses a passkey saved on this device or on a nearby phone.',
      or: 'or',
      checking: 'Checking passkey support…',
      unsupported:
        'This browser does not support passkeys (WebAuthn). Use your password and your verification code.',
      cancelled: 'Cancelled or timed out. Please try again.',
      failed: 'The passkey could not be verified. Please try again.',
      add: 'Add a passkey',
      nameLabel: 'Passkey name',
      namePlaceholder: 'E.g. Fatou’s iPhone',
      added: 'Passkey added.',
      addProofHint:
        'For your security, confirm your password: a passkey gives lasting access to your account.',
      empty: 'No passkey registered yet.',
      createdAt: 'Added on',
      lastUsed: 'Last used',
      never: 'never',
      synced: 'Synced',
      deviceBound: 'Device-bound',
      rename: 'Rename',
      renamed: 'Passkey renamed.',
      revoke: 'Revoke',
      revokeTitle: 'Revoke this passkey?',
      revokeDescription: 'It will no longer sign you in or confirm an operation. You will be notified.',
      revoked: 'Passkey revoked.',
      stepUp: {
        codeLabel: 'Verification code or recovery code',
        codeHint: '6 digits from your authenticator app, or an XXXX-XXXX-XX recovery code.',
        usePasskey: 'Confirm with a passkey',
        required: 'This change lowers your protection: confirm it with a code or a passkey.',
      },
      mfa: {
        recoveryToggle: 'Use a recovery code',
        totpToggle: 'Use the app code',
        recoveryLabel: 'Recovery code',
        recoveryHint: 'Format XXXX-XXXX-XX. Each code works only once.',
        usePasskey: 'Use a passkey',
        disableHint: 'To disable, enter an app code or a recovery code, or confirm with a passkey.',
        enabledWithCodes: 'Two-factor authentication enabled. Keep your recovery codes below.',
        errors: {
          VALIDATION_FAILED: 'Invalid code: check the code shown by your authenticator app.',
        },
      },
      recovery: {
        title: 'Recovery codes',
        description:
          'If you lose access to your authenticator app, a recovery code replaces the 6-digit code. Each code works only once.',
        remaining: '{count} of {total} code(s) available',
        generatedAt: 'Generated on',
        low: 'You are running out of codes: consider regenerating them.',
        regenerate: 'Regenerate codes',
        regenerateTitle: 'Regenerate recovery codes?',
        regenerateHint: 'Previous codes stop working immediately.',
        showOnceTitle: 'Your recovery codes',
        showOnce: 'Store them somewhere safe (password manager, paper): they will never be shown again.',
        copyAll: 'Copy codes',
        done: 'I have saved my codes',
        mfaRequired: 'Enable two-factor authentication (TOTP) first to get recovery codes.',
      },
      transfer: {
        codeHint: '6-digit code from your app, or a recovery code.',
        usePasskey: 'Authorise with a passkey',
      },
      errors: {
        MFA_REQUIRED: 'Invalid or missing verification code.',
        MFA_CODE_REUSED:
          'This code has already been used. Wait for the next code from your authenticator app.',
        RECOVERY_CODE_INVALID: 'This recovery code is invalid or has already been used.',
        STEP_UP_REQUIRED:
          'Confirmation refused: the code, passkey or password provided is missing or invalid.',
        PASSKEY_VERIFICATION_FAILED: 'The passkey could not be verified. Please try again.',
        PASSKEY_NOT_FOUND: 'Passkey not found or already revoked.',
        CHALLENGE_EXPIRED: 'The passkey request expired or was already used. Start again.',
        ACCOUNT_LOCKED: 'Too many failed attempts: access is temporarily blocked. Try again later.',
        RATE_LIMITED: 'Too many attempts in a short time. Wait a moment and try again.',
      },
    },
  },
);
