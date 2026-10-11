import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { StorageService } from './storage.service';

@Module({
  imports: [OrganizationsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, StorageService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
