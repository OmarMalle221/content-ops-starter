import { NextResponse } from 'next/server';
import { getApp } from '@/server/instance';

export async function GET() {
    const app = await getApp();
    return NextResponse.json(
        {
            status: 'ok',
            mode: app.config.mode,
            paymentProvider: app.deps.payments.name,
            simulated: app.deps.payments.simulated,
            realFunds: false
        },
        { headers: { 'cache-control': 'no-store' } }
    );
}
