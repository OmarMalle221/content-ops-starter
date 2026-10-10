import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UuidV7Generator, uuidV7Timestamp } from '@/server/adapters/uuid-v7';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** rand_a (12-bit counter) of a UUIDv7. */
const counterOf = (id: string) => parseInt(id.slice(15, 18), 16);

describe('UUIDv7 generator', () => {
    it('produces canonical lowercase RFC 9562 version 7 / variant 10 ids carrying the current time', () => {
        const before = Date.now();
        const id = new UuidV7Generator().id();
        const after = Date.now();
        expect(id).toMatch(V7);
        expect(id[14]).toBe('7');
        expect(['8', '9', 'a', 'b']).toContain(id[19]);
        expect(uuidV7Timestamp(id)).toBeGreaterThanOrEqual(before);
        expect(uuidV7Timestamp(id)).toBeLessThanOrEqual(after);
    });

    it('is strictly monotonic over 10 000 ids', () => {
        const gen = new UuidV7Generator();
        const ids = Array.from({ length: 10_000 }, () => gen.id());
        for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => V7.test(id))).toBe(true);
    });

    it('increments the counter within one millisecond and starts it at a random value each millisecond', () => {
        let now = 1_800_000_000_000;
        const gen = new UuidV7Generator(() => now);
        const first = gen.id();
        const second = gen.id();
        expect(counterOf(first)).toBeLessThanOrEqual(0x7ff);
        expect(counterOf(second)).toBe(counterOf(first) + 1);
        expect(uuidV7Timestamp(second)).toBe(now);
        now += 1;
        const third = gen.id();
        expect(uuidV7Timestamp(third)).toBe(now);
        expect(third > second).toBe(true);
    });

    it('stays monotonic when the wall clock goes backwards', () => {
        let now = 1_800_000_000_000;
        const gen = new UuidV7Generator(() => now);
        const a = gen.id();
        now -= 5_000;
        const b = gen.id();
        const c = gen.id();
        expect(b > a && c > b).toBe(true);
        expect(uuidV7Timestamp(b)).toBe(1_800_000_000_000);
    });

    it('carries into the next millisecond when the 12-bit counter is exhausted', () => {
        const now = 1_800_000_000_000;
        const gen = new UuidV7Generator(() => now);
        const ids = Array.from({ length: 5_000 }, () => gen.id());
        for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
        expect(uuidV7Timestamp(ids.at(-1)!)).toBeGreaterThan(now);
    });

    it('is accepted by the zod uuid validators used in the code base', () => {
        const id = new UuidV7Generator().id();
        expect(z.string().uuid().safeParse(id).success).toBe(true);
        expect(z.uuid().safeParse(id).success).toBe(true);
        expect(z.guid().safeParse(id).success).toBe(true);
    });
});
