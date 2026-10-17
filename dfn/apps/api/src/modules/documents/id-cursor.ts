import { randomUUID } from 'node:crypto';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Keyset scan over document ids for the maintenance jobs (purge, storage migration): pages are
 * read in id order from a random starting point and wrap around once. Rows that keep failing
 * therefore cannot pin every run to the same window, and a run stopped anywhere (batch cap, time
 * budget, lost lease) loses nothing: processed rows no longer match the job's filter.
 */
export class WrappingIdCursor {
  private readonly start: string;
  private wrapped = false;
  after: string;

  constructor(start: string = randomUUID()) {
    this.start = start;
    this.after = start;
  }

  /** Prisma filter on `id` for the next page. */
  get idFilter(): { gt: string; lte?: string } {
    return this.wrapped ? { gt: this.after, lte: this.start } : { gt: this.after };
  }

  /** Called when a page comes back empty: false once the whole id space has been covered. */
  wrap(): boolean {
    if (this.wrapped) return false;
    this.wrapped = true;
    this.after = ZERO_UUID;
    return true;
  }
}

const MANUAL_ACTOR = /^manual:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** User id of a run started from a console (`manual:<userId>…`), null for the scheduler. */
export function actorFromTrigger(triggeredBy: string): string | null {
  return MANUAL_ACTOR.exec(triggeredBy)?.[1]?.toLowerCase() ?? null;
}
