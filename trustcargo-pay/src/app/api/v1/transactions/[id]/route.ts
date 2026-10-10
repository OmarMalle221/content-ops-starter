import { apiRoute, json } from '@/server/http/api';

export const GET = apiRoute<{ id: string }>(async ({ app, actor, params }) =>
    json({ data: await app.views.transaction(actor, params.id) })
);
