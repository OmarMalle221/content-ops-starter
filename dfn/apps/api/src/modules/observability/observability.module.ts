import { Global, Module } from '@nestjs/common';

/**
 * Phase 7 — observability: Prometheus metrics (GET /metrics), request / job / webhook
 * instrumentation and trace-context propagation. Global so that any module can record metrics
 * without importing it explicitly. Skeleton registered by the phase 7 foundation; providers and
 * controllers are added by the observability work area.
 */
@Global()
@Module({})
export class ObservabilityModule {}
