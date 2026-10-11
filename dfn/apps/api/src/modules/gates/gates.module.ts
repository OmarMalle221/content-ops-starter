import { Module } from '@nestjs/common';

/**
 * Regulatory gates register (R1–R10) and partner activation guard (phase 6).
 * Tracking only: no gate status ever switches DFN_MODE out of sandbox.
 */
@Module({})
export class GatesModule {}
