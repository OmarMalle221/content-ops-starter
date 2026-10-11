import { Module } from '@nestjs/common';
import { VerificationsModule } from '../verifications/verifications.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({ imports: [VerificationsModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
