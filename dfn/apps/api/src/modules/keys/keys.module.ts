import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { KeyRotationService } from './key-rotation.service';
import { KeysController } from './keys.controller';
import { KeysService } from './keys.service';

/**
 * Key ring status and re-encryption (key rotation) of sealed secrets and documents (phase 6).
 * Registers ENCRYPTION_KEY_ROTATION on the global JobRegistry; runs go through MaintenanceService.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [KeysController],
  providers: [KeysService, KeyRotationService],
  exports: [KeysService, KeyRotationService],
})
export class KeysModule {}
