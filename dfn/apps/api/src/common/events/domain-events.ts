import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * Minimal in-process domain event bus. Producers emit after their database transaction
 * commits; consumers (webhooks, invoices, notifications) subscribe at module init.
 * Handlers run asynchronously and never throw back into the producer.
 */
export interface DomainEvent {
  type: string;
  /** Organisations concerned by the event (used to route partner webhooks). */
  organizationIds: string[];
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export type DomainEventHandler = (event: DomainEvent) => Promise<void> | void;

@Injectable()
export class DomainEventsBus {
  private readonly logger = new Logger(DomainEventsBus.name);
  private readonly handlers: DomainEventHandler[] = [];

  on(handler: DomainEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  emit(event: Omit<DomainEvent, 'occurredAt'> & { occurredAt?: Date }): void {
    const full: DomainEvent = { ...event, occurredAt: event.occurredAt ?? new Date() };
    for (const handler of this.handlers) {
      Promise.resolve()
        .then(() => handler(full))
        .catch((err) =>
          this.logger.error(
            `handler failed for ${full.type}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }
}

@Global()
@Module({ providers: [DomainEventsBus], exports: [DomainEventsBus] })
export class DomainEventsModule {}
