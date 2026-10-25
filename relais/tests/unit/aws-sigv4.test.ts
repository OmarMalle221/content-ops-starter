// Signature AWS SigV4 vérifiée sur les exemples publiés par AWS (suite de tests SigV4 et exemple IAM de la
// documentation), puis requête SES construite sans réseau.
import { describe, expect, it } from 'vitest';
import { EmailError, SesEmailClient, signAwsRequest, signingKey } from '../../supabase/functions/_shared/email';

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2015-08-30T12:36:00Z');
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('AWS Signature Version 4', () => {
    it('clé de signature (exemple de la documentation AWS)', async () => {
        expect(hex(await signingKey(CREDENTIALS.secretAccessKey, '20150830', 'us-east-1', 'iam'))).toBe(
            'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9'
        );
    });

    it('get-vanilla (suite de tests SigV4)', async () => {
        const headers = await signAwsRequest({
            method: 'GET',
            url: 'https://example.amazonaws.com/',
            headers: {},
            body: '',
            region: 'us-east-1',
            service: 'service',
            ...CREDENTIALS,
            now: NOW
        });
        expect(headers.authorization).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
        );
        expect(headers['x-amz-date']).toBe('20150830T123600Z');
    });

    it('IAM ListUsers avec chaîne de requête (documentation AWS)', async () => {
        const headers = await signAwsRequest({
            method: 'GET',
            url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
            body: '',
            region: 'us-east-1',
            service: 'iam',
            ...CREDENTIALS,
            now: NOW
        });
        expect(headers.authorization).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7'
        );
    });
});

describe('client SES', () => {
    it('appelle l’API SES v2 de la région canadienne, requête signée', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const client = new SesEmailClient({
            ...CREDENTIALS,
            from: 'Relais <rappels@relais.example>',
            now: () => NOW,
            fetch: async (url, init) => {
                calls.push({ url: String(url), init: init ?? {} });
                return new Response('{"MessageId":"x"}', { status: 200 });
            }
        });
        await client.send({ to: 'claire@example.test', subject: 'Sujet', text: 'Texte', html: '<p>Texte</p>' });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('https://email.ca-central-1.amazonaws.com/v2/email/outbound-emails');
        const headers = calls[0]!.init.headers as Record<string, string>;
        expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/ca-central-1\/ses\/aws4_request, /);
        expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
            FromEmailAddress: 'Relais <rappels@relais.example>',
            Destination: { ToAddresses: ['claire@example.test'] },
            Content: { Simple: { Subject: { Data: 'Sujet' }, Body: { Text: { Data: 'Texte' } } } }
        });
    });

    it('erreur du fournisseur : code HTTP seulement, sans adresse ni contenu', async () => {
        const client = new SesEmailClient({
            ...CREDENTIALS,
            from: 'rappels@relais.example',
            fetch: async () => new Response('{"message":"Email address is not verified: claire@example.test"}', { status: 400 })
        });
        const error = await client.send({ to: 'claire@example.test', subject: 'S', text: 'T', html: 'H' }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EmailError);
        expect((error as EmailError).status).toBe(400);
        expect(String((error as Error).message)).not.toContain('claire');
    });
});
