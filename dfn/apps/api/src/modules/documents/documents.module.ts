import { Module } from '@nestjs/common';
import { AntivirusModule } from '../../common/antivirus/antivirus.module';
import { StorageModule } from '../../common/storage/storage.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DocumentPurgeService } from './document-purge.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { StorageAdminController } from './storage-admin.controller';
import { StorageAdminService } from './storage-admin.service';
import { StorageMigrationService } from './storage-migration.service';
import { DocumentStorageService } from './storage.service';

/**
 * Documents: upload validation and antivirus scan, encrypted object storage (local or
 * S3-compatible, sealed with the key ring), review, access control and audit. Registers the
 * DOCUMENT_PURGE and STORAGE_MIGRATION maintenance jobs on the global JobRegistry and serves the
 * storage console (/v1/admin/storage). DocumentStorageService is exported for the key rotation job
 * (KeysModule).
 */
@Module({
  imports: [OrganizationsModule, StorageModule, AntivirusModule],
  controllers: [DocumentsController, StorageAdminController],
  providers: [
    DocumentsService,
    DocumentStorageService,
    DocumentPurgeService,
    StorageMigrationService,
    StorageAdminService,
  ],
  exports: [DocumentsService, DocumentStorageService],
})
export class DocumentsModule {}
