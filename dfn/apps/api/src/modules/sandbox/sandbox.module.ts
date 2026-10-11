import { Module } from '@nestjs/common';
import { SandboxController } from './sandbox.controller';

@Module({ controllers: [SandboxController] })
export class SandboxModule {}
