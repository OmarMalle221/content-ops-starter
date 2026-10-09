import { apiRoute, json } from '@/server/http/api';

/** Metadata only. Content is obtained through short-lived signed URLs (see document UI / content route). */
export const GET = apiRoute<{ id: string }>(async ({ app, actor, params }) => {
    const docs = await app.documents.listForTransaction(actor, params.id);
    return json({ data: docs.map(({ storageKey: _k, ...d }) => d) });
});
