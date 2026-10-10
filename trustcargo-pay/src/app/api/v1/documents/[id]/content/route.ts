import { NextResponse, type NextRequest } from 'next/server';
import { problem } from '@/server/http/api';
import { getActor } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { getApp } from '@/server/instance';
import { randomToken } from '@/server/security/crypto';

/** Serves a document only with a valid, unexpired, user-bound signature AND a fresh authorisation check. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const requestId = randomToken(8);
    try {
        const app = await getApp();
        const actor = await getActor();
        if (!actor) throw new AppError('UNAUTHENTICATED', 'Authentication required');
        const { id } = await params;
        const file = await app.documents.readContent(actor, id, req.nextUrl.searchParams.get('exp'), req.nextUrl.searchParams.get('sig'));
        return new NextResponse(Buffer.from(file.bytes), {
            headers: {
                'content-type': file.mimeType,
                'content-disposition': `inline; filename="${file.fileName.replace(/"/g, '')}"`,
                'cache-control': 'private, no-store',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
                'x-request-id': requestId
            }
        });
    } catch (error) {
        return problem(error, requestId);
    }
}
