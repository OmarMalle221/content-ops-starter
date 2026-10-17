import type { Env } from '../../config/env';
import { AwsKmsProvider } from './aws-kms.provider';
import type { KmsProvider } from './kms-provider';
import { LocalKmsProvider } from './local-kms.provider';

export * from './kms-provider';
export { AwsKmsProvider, awsKmsFailureReason } from './aws-kms.provider';
export { LocalKmsProvider, localMasterKeyFingerprint } from './local-kms.provider';

/**
 * The KMS selected by KMS_PROVIDER, or null for "none" (data keys only from ENCRYPTION_KEYRING,
 * phase 6 behaviour). The environment schema already guarantees the provider's settings exist.
 */
export function createKmsProvider(
  env: Pick<Env, 'KMS_PROVIDER' | 'KMS_LOCAL_MASTER_KEY' | 'KMS_KEY_ID' | 'KMS_REGION' | 'KMS_ENDPOINT'>,
): KmsProvider | null {
  switch (env.KMS_PROVIDER) {
    case 'local':
      return new LocalKmsProvider(env.KMS_LOCAL_MASTER_KEY ?? '');
    case 'aws':
      return AwsKmsProvider.fromEnv(env);
    default:
      return null;
  }
}
