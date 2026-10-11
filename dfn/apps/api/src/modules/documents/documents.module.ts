import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentStorageService } from './storage.service';

/**
 * Documents: upload validation, encrypted object storage (local or S3-compatible, sealed with the
 * key ring), review, access control and audit. DocumentStorageService is exported for the key
 * rotation job (KeysModule).
 */
@Module({
  imports: [OrganizationsModule, StorageModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentStorageService],
  exports: [DocumentsService, DocumentStorageService],
})
export class DocumentsModule {}
