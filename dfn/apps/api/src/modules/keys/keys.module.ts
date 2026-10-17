import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { KeyLifecycleService } from './key-lifecycle.service';
import { KeyRotationService } from './key-rotation.service';
import { KeysController } from './keys.controller';
import { KeysService } from './keys.service';
import { ManagedKeysService } from './managed-keys.service';

/**
 * Key ring status, KMS-managed data keys (phase 7: envelope encryption, lifecycle, scheduled
 * rotation) and re-encryption (key rotation) of sealed secrets and documents (phase 6).
 * Registers ENCRYPTION_KEY_ROTATION and KEY_LIFECYCLE on the global JobRegistry; runs go through
 * MaintenanceService. ManagedKeysService loads the managed keys into the key ring at boot (failing
 * fast when the KMS cannot unwrap them) and every KEYRING_REFRESH_SECONDS.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [KeysController],
  providers: [ManagedKeysService, KeyLifecycleService, KeysService, KeyRotationService],
  exports: [KeysService, KeyRotationService, ManagedKeysService],
})
export class KeysModule {}
