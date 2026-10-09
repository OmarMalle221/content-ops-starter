import { apiRoute, json, readJson } from '@/server/http/api';

export const POST = apiRoute<{ id: string; milestoneId: string }>(async ({ req, app, actor, params }) => {
    const body = await readJson<{ note?: string }>(req);
    const tx = await app.milestones.submit(actor, params.id, params.milestoneId, typeof body.note === 'string' ? body.note : undefined);
    return json({ data: { status: tx.status } });
});
