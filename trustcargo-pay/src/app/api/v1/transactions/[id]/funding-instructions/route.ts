import { apiRoute, json } from '@/server/http/api';

export const POST = apiRoute<{ id: string }>(
    async ({ app, actor, params }) => {
        const i = await app.payments.requestFundingInstructions(actor, params.id);
        return json(
            {
                data: {
                    id: i.id,
                    status: i.status,
                    amount: i.amount,
                    details: i.details,
                    expiresAt: i.expiresAt,
                    simulated: app.deps.payments.simulated
                }
            },
            201
        );
    },
    { rateLimit: { limit: 10, windowMs: 600_000 } }
);
