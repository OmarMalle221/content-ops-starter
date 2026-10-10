import { describe, expect, it, vi } from 'vitest';
import { MemoryFileStorage } from '@/server/adapters/mock/mock-providers';
import { logger } from '@/server/logger';
import type { UnitOfWork } from '@/server/ports/db';
import type { FileStorage } from '@/server/ports/providers';
import { actors, createTestApp } from './helpers';
import { createAndInvite, pdf, submitMilestone, toInProgress } from './flow';

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

    it('checks the replaced version and the milestone before storing: a refused upload leaves no object', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const storage = app.deps.storage as MemoryFileStorage;
        const put = vi.spyOn(storage, 'put');
        const before = storage.keys().length;
        const view = await app.views.transaction(a.seller, txId);
        const open = view.milestones.find((m) => m.status === 'ACTIVE')!;
        const sellerPhoto = await app.documents.upload(a.seller, { transactionId: txId, type: 'PHOTO', title: 'Photo' }, pdf('photo'));
        put.mockClear();
        const buyerPhoto = await app.documents.upload(a.buyer, { transactionId: txId, type: 'PHOTO', title: 'Photo' }, pdf('b'));
        put.mockClear();
        const approved = await submitMilestone(app, a.seller, txId, 0);
        await app.milestones.review(a.buyer, txId, approved, { decision: 'APPROVE' });
        const count = storage.keys().length;
        put.mockClear();

        const refused: [string, typeof a.seller, Record<string, unknown>, string][] = [
            ['unknown version', a.seller, { type: 'PHOTO', replacesDocumentId: app.deps.ids.id() }, 'NOT_FOUND'],
            ['version of another type', a.seller, { type: 'INVOICE', replacesDocumentId: sellerPhoto.id }, 'NOT_FOUND'],
            ["another uploader's version", a.buyer, { type: 'PHOTO', replacesDocumentId: sellerPhoto.id }, 'FORBIDDEN'],
            ['milestone from a role that cannot attach evidence', a.buyer, { type: 'PHOTO', milestoneId: open.id }, 'FORBIDDEN'],
            ['unknown milestone', a.seller, { type: 'PHOTO', milestoneId: app.deps.ids.id() }, 'NOT_FOUND'],
            ['closed milestone', a.seller, { type: 'PHOTO', milestoneId: approved }, 'PRECONDITION_FAILED']
        ];
        for (const [name, actor, input, code] of refused) {
            await expect(
                app.documents.upload(actor, { transactionId: txId, title: name, ...input }, pdf('refused')),
                name
            ).rejects.toMatchObject({ code });
        }
        expect(put).not.toHaveBeenCalled();
        expect(storage.keys()).toHaveLength(count);
        expect(count).toBeGreaterThan(before);
        // The same requests, valid, still go through.
        await expect(
            app.documents.upload(a.buyer, { transactionId: txId, type: 'PHOTO', title: 'v2', replacesDocumentId: buyerPhoto.id }, pdf('v2'))
        ).resolves.toMatchObject({ version: 2 });
    });

    it('removes the stored object when the unit of work fails after the upload, keeping the original error', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx } = await createAndInvite(app, a.seller);
        const storage = app.deps.storage as MemoryFileStorage;
        const before = storage.keys();
        const remove = vi.spyOn(storage, 'delete');
        vi.spyOn(app.risk, 'evaluateInTx').mockRejectedValueOnce(new Error('risk engine down'));
        await expect(app.documents.upload(a.seller, { transactionId: tx.id, type: 'PHOTO', title: 'Photo' }, pdf('photo'))).rejects.toThrow(
            'risk engine down'
        );
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove.mock.calls[0]![0]).toMatch(new RegExp(`^${tx.id}/`));
        expect(storage.keys()).toEqual(before);
        expect((await app.documents.listForTransaction(a.seller, tx.id)).filter((d) => d.type === 'PHOTO')).toEqual([]);

        // A failing removal is only logged: the caller still gets the original error.
        const warn = vi.spyOn(logger, 'warn');
        remove.mockRejectedValueOnce(new Error('storage down'));
        vi.spyOn(app.risk, 'evaluateInTx').mockRejectedValueOnce(new Error('risk engine down again'));
        await expect(
            app.documents.upload(a.seller, { transactionId: tx.id, type: 'PHOTO', title: 'Photo' }, pdf('photo-2'))
        ).rejects.toThrow('risk engine down again');
        expect(warn).toHaveBeenCalledWith('document.orphan_object_kept', expect.objectContaining({ error: 'Error' }));
        expect(storage.keys()).toHaveLength(before.length + 1);
    });
});
