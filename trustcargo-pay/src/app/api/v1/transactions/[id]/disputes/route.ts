import { apiRoute, json, readJson } from '@/server/http/api';

export const POST = apiRoute<{ id: string }>(
    async ({ req, app, actor, params }) => {
        const r = await app.disputes.open(actor, params.id, await readJson(req));
        return json({ data: { disputeId: r.dispute.id, status: r.transaction.status } }, 201);
    },
    { rateLimit: { limit: 5, windowMs: 3_600_000 } }
);
