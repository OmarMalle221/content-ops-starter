// Envoi de courriels par Amazon SES (API v2, région ca-central-1 par défaut : hébergement au Canada).
// Les fonctions Edge ne peuvent pas ouvrir de connexion SMTP : on passe par l'API HTTPS, signée avec AWS
// Signature Version 4 (WebCrypto, aucune dépendance). Aucune erreur ne contient l'adresse ni le contenu.

export interface EmailMessage {
    to: string;
    subject: string;
    text: string;
    html: string;
}

export interface EmailClient {
    send(message: EmailMessage): Promise<void>;
}

export class EmailError extends Error {
    readonly status: number;
    constructor(status: number) {
        super(`email provider error ${status}`);
        this.name = 'EmailError';
        this.status = status;
    }
}

// ----------------------------------------------------------------------------------------- SigV4
const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(data: string): Promise<string> {
    return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

/** Octets d'un texte dans un ArrayBuffer à part (même typage pour le TypeScript de Deno 2.1 et le récent). */
function textBuffer(text: string): ArrayBuffer {
    const view = encoder.encode(text);
    const buffer = new ArrayBuffer(view.byteLength);
    new Uint8Array(buffer).set(view);
    return buffer;
}

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

/** Encodage RFC 3986 exigé par AWS (encodeURIComponent laisse passer ! ' ( ) *). */
const awsEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export async function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
    const kDate = await hmac(textBuffer(`AWS4${secretAccessKey}`), dateStamp);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}

export interface AwsRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
    region: string;
    service: string;
    accessKeyId: string;
    secretAccessKey: string;
    now: Date;
}

/** En-têtes signés (x-amz-date et authorization ajoutés). */
export async function signAwsRequest(request: AwsRequest): Promise<Record<string, string>> {
    const url = new URL(request.url);
    const amzDate = request.now
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = { ...request.headers, host: url.host, 'x-amz-date': amzDate };

    const canonicalHeaders = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const signedHeaders = canonicalHeaders.map(([name]) => name).join(';');
    const canonicalQuery = [...url.searchParams.entries()]
        .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
        .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    const canonicalPath = url.pathname
        .split('/')
        .map((segment) => awsEncode(decodeURIComponent(segment)))
        .join('/');
    const canonicalRequest = [
        request.method.toUpperCase(),
        canonicalPath || '/',
        canonicalQuery,
        canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join(''),
        signedHeaders,
        await sha256Hex(request.body)
    ].join('\n');

    const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    const key = await signingKey(request.secretAccessKey, dateStamp, request.region, request.service);
    const signature = toHex(await hmac(key, stringToSign));
    return {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    };
}

// ------------------------------------------------------------------------------------------- SES
export interface SesOptions {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    from: string;
    fetch?: typeof fetch;
    now?: () => Date;
    timeoutMs?: number;
}

export class SesEmailClient implements EmailClient {
    readonly #options: Required<Omit<SesOptions, 'fetch'>> & { fetch: typeof fetch };

    constructor(options: SesOptions) {
        this.#options = {
            region: 'ca-central-1',
            now: () => new Date(),
            timeoutMs: 10_000,
            ...options,
            fetch: options.fetch ?? ((input, init) => fetch(input, init))
        };
    }

    async send(message: EmailMessage): Promise<void> {
        const { region, from, accessKeyId, secretAccessKey, now, timeoutMs } = this.#options;
        const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
        const body = JSON.stringify({
            FromEmailAddress: from,
            Destination: { ToAddresses: [message.to] },
            Content: {
                Simple: {
                    Subject: { Data: message.subject, Charset: 'UTF-8' },
                    Body: { Text: { Data: message.text, Charset: 'UTF-8' }, Html: { Data: message.html, Charset: 'UTF-8' } }
                }
            }
        });
        const headers = await signAwsRequest({
            method: 'POST',
            url,
            headers: { 'content-type': 'application/json' },
            body,
            region,
            service: 'ses',
            accessKeyId,
            secretAccessKey,
            now: now()
        });
        const response = await this.#options.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new EmailError(response.status);
    }
}
