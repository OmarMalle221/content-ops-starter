/**
 * Time-ordered identifiers: UUID version 7 (RFC 9562 §5.7) with a monotonic counter (§6.2, method 1).
 *
 *   48 bits  unix_ts_ms   milliseconds since the Unix epoch
 *    4 bits  ver          0b0111
 *   12 bits  rand_a       counter: random start each millisecond (top bit cleared), +1 per id
 *    2 bits  var          0b10
 *   62 bits  rand_b       random
 *
 * Ids are strictly increasing within the process, also when several are created in the same
 * millisecond or when the wall clock steps backwards (the last timestamp is kept and the counter
 * carries into it). Sorting by id therefore follows creation order, which the Postgres adapter
 * relies on (`ORDER BY id`) to reproduce the in-memory insertion order.
 */
import { randomBytes } from 'node:crypto';
import type { IdGenerator } from '@/server/ports/providers';

const COUNTER_MAX = 0xfff;

export class UuidV7Generator implements IdGenerator {
    private lastMs = -1;
    private counter = 0;

    /** `now` is injectable for tests (clock steps, counter overflow). */
    constructor(private readonly now: () => number = Date.now) {}

    id(): string {
        const random = randomBytes(10);
        const ms = this.now();
        if (ms > this.lastMs) {
            this.lastMs = ms;
            this.counter = random.readUInt16BE(8) & 0x7ff;
        } else if (this.counter < COUNTER_MAX) {
            // Same millisecond, or the clock went backwards: stay on the last timestamp.
            this.counter += 1;
        } else {
            // Counter exhausted: borrow the next millisecond rather than repeat or go back.
            this.lastMs += 1;
            this.counter = random.readUInt16BE(8) & 0x7ff;
        }

        const bytes = Buffer.alloc(16);
        bytes.writeUIntBE(this.lastMs, 0, 6);
        bytes[6] = 0x70 | (this.counter >> 8);
        bytes[7] = this.counter & 0xff;
        random.copy(bytes, 8, 0, 8);
        bytes[8] = 0x80 | (bytes[8]! & 0x3f);

        const hex = bytes.toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
}

/** Milliseconds encoded in a UUIDv7 (diagnostics and tests). */
export function uuidV7Timestamp(id: string): number {
    return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
