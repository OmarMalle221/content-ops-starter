import { describe, expect, it } from 'vitest';
import type { UnitOfWork } from '@/server/ports/db';
import type { FileStorage } from '@/server/ports/providers';
import { actors, createTestApp } from './helpers';
import { createAndInvite, pdf } from './flow';

describe('document storage', () => {
    it('writes the object outside any unit of work, under a key unique to the upload', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx } = await createAndInvite(app, a.seller);

        // Instrument the ports the service reads at call time: depth > 0 means "inside a unit of work".
        let depth = 0;
        const uow: UnitOfWork = app.deps.uow;
        app.deps.uow = {
            run: async (fn) => {
                depth++;
                try {
                    return await uow.run(fn);
                } finally {
                    depth--;
                }
            }
        };
        const storage: FileStorage = app.deps.storage;
        const puts: { key: string; depth: number }[] = [];
        app.deps.storage = {
            put: async (key, bytes, contentType) => {
                puts.push({ key, depth });
                await storage.put(key, bytes, contentType);
            },
            get: (key) => storage.get(key)
        };

        const doc = await app.documents.upload(a.seller, { transactionId: tx.id, type: 'PHOTO', title: 'Photo avant' }, pdf('photo'));
        expect(puts).toEqual([{ key: doc.storageKey, depth: 0 }]);
        expect(doc.storageKey).toBe(`${tx.id}/${doc.id}/${doc.sha256}`);
        expect(await storage.get(doc.storageKey)).toBeDefined();

        // A refused upload never reaches storage: authorisation runs first (the buyer has not joined yet).
        await expect(
            app.documents.upload(a.buyer, { transactionId: tx.id, type: 'PHOTO', title: 'not allowed' }, pdf('photo-2'))
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(puts).toHaveLength(1);
    });
});
