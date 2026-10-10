import { apiRoute, json, readJson } from '@/server/http/api';

export const GET = apiRoute(async ({ app, actor }) => json({ data: await app.transactions.listForActor(actor) }));

export const POST = apiRoute(
    async ({ req, app, actor }) => {
        const tx = await app.transactions.createVehicleTransaction(actor, await readJson(req));
        return json({ data: tx }, 201, { location: `/api/v1/transactions/${tx.id}` });
    },
    { rateLimit: { limit: 20, windowMs: 3_600_000 } }
);
