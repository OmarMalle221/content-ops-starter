import { Module } from '@nestjs/common';
import { AntivirusService } from './antivirus.service';

/** Antivirus scanning of uploads (ANTIVIRUS_PROVIDER); imported by DocumentsModule. */
@Module({
  providers: [AntivirusService],
  exports: [AntivirusService],
})
export class AntivirusModule {}
