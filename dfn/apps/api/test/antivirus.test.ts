import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AntivirusService,
  ClamdScanner,
  EICAR_TEST_STRING,
  SandboxEicarScanner,
  ScanUnavailableError,
  createScanner,
  parseClamdReply,
  sanitizeSignature,
  type ScanFailureReason,
} from '../src/common/antivirus';
import { loadEnv } from '../src/config/env';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { Client, PDF_BYTES, bootTestApp, registerUser, resetDatabase, type TestContext } from './helpers/app';

const EICAR = Buffer.from(EICAR_TEST_STRING, 'latin1');
/** A valid PDF (magic bytes) that carries the EICAR test string in its body. */
const EICAR_PDF = Buffer.concat([PDF_BYTES, Buffer.from('% '), EICAR, Buffer.from('\n%%EOF\n')]);

type FakeMode = 'scan' | 'engine-error' | 'silent' | 'garbage' | 'drop' | 'size-limit';

interface FakeClamd {
  port: number;
  /** Payloads received (reassembled from the INSTREAM chunks), one per connection. */
  payloads: Buffer[];
  /** Size of every INSTREAM chunk received, per connection. */
  chunkSizes: number[][];
  commands: string[];
  close: () => Promise<void>;
}

/**
 * Minimal clamd implementing the INSTREAM protocol: NUL-terminated z-command, 4-byte big-endian
 * chunk lengths, zero-length terminator, one NUL-terminated reply. Parses across arbitrary TCP
 * segment boundaries.
 */
async function startFakeClamd(
  mode: FakeMode = 'scan',
  opts: { signature?: string; sizeLimit?: number; splitReply?: boolean } = {},
): Promise<FakeClamd> {
  const payloads: Buffer[] = [];
  const chunkSizes: number[][] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const reply = (socket: Socket, text: string) => {
    if (!opts.splitReply) return void socket.end(`${text}\0`);
    // Delivered in three TCP writes: the client must reassemble the line.
    socket.write(text.slice(0, 3));
    setTimeout(() => socket.write(text.slice(3, 9)), 15);
    setTimeout(() => socket.end(`${text.slice(9)}\0`), 30);
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let stage: 'command' | 'chunks' | 'done' = 'command';
    const parts: Buffer[] = [];
    const sizes: number[] = [];
    let total = 0;
    const respond = () => {
      const payload = Buffer.concat(parts);
      payloads.push(payload);
      chunkSizes.push(sizes);
      if (mode === 'silent') return;
      if (mode === 'drop') return void socket.destroy();
      if (mode === 'garbage') return reply(socket, 'HELLO THERE');
      if (mode === 'engine-error') return reply(socket, "Can't allocate memory ERROR");
      reply(
        socket,
        payload.includes(EICAR) ? `stream: ${opts.signature ?? 'Eicar-Signature'} FOUND` : 'stream: OK',
      );
    };
    socket.on('data', (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      while (stage !== 'done') {
        if (stage === 'command') {
          const nul = buf.indexOf(0);
          if (nul === -1) return;
          const command = buf.subarray(0, nul).toString('latin1');
          commands.push(command);
          buf = buf.subarray(nul + 1);
          if (command === 'zPING') {
            stage = 'done';
            return void socket.end('PONG\0');
          }
          if (command !== 'zINSTREAM') {
            stage = 'done';
            return void socket.end('UNKNOWN COMMAND\0');
          }
          stage = 'chunks';
          continue;
        }
        if (buf.length < 4) return;
        const length = buf.readUInt32BE(0);
        if (length === 0) {
          stage = 'done';
          buf = buf.subarray(4);
          return respond();
        }
        if (buf.length < 4 + length) return;
        parts.push(Buffer.from(buf.subarray(4, 4 + length)));
        sizes.push(length);
        total += length;
        buf = buf.subarray(4 + length);
        if (opts.sizeLimit !== undefined && total > opts.sizeLimit) {
          stage = 'done';
          return void socket.end('INSTREAM size limit exceeded. ERROR\0');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    payloads,
    chunkSizes,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function scanFailure(promise: Promise<unknown>): Promise<ScanUnavailableError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScanUnavailableError);
  const scanErr = err as ScanUnavailableError;
  expect(scanErr.code).toBe('SCAN_UNAVAILABLE');
  expect(scanErr.status).toBe(503);
  return scanErr;
}

describe('sandbox scanner (EICAR simulation)', () => {
  it('flags the EICAR test string anywhere in the file, and nothing else', async () => {
    const scanner = new SandboxEicarScanner();
    expect(scanner.engine).toBe('sandbox-eicar');
    expect(EICAR_TEST_STRING).toHaveLength(68);
    expect(await scanner.scan(EICAR)).toEqual({ verdict: 'INFECTED', signature: 'Eicar-Test-Signature' });
    expect((await scanner.scan(EICAR_PDF)).verdict).toBe('INFECTED');
    expect((await scanner.scan(Buffer.concat([Buffer.alloc(5000, 7), EICAR]))).verdict).toBe('INFECTED');
    expect(await scanner.scan(PDF_BYTES)).toEqual({ verdict: 'CLEAN' });
    // A truncated or altered test string is not the test string.
    expect((await scanner.scan(EICAR.subarray(0, 60))).verdict).toBe('CLEAN');
    const altered = Buffer.from(EICAR);
    altered[10] = 0x41;
    expect((await scanner.scan(altered)).verdict).toBe('CLEAN');
  });
});

describe('clamd reply parsing', () => {
  it('maps clamd answers to verdicts or failure reasons', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ verdict: 'CLEAN' });
    expect(parseClamdReply('stream: OK\n')).toEqual({ verdict: 'CLEAN' });
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND')).toEqual({
      verdict: 'INFECTED',
      signature: 'Win.Test.EICAR_HDB-1',
    });
    expect(parseClamdReply('1: stream: Eicar-Signature FOUND')).toEqual({
      verdict: 'INFECTED',
      signature: 'Eicar-Signature',
    });
    expect(parseClamdReply('INSTREAM size limit exceeded. ERROR')).toBe('SIZE_LIMIT');
    expect(parseClamdReply("Can't allocate memory ERROR")).toBe('ENGINE_ERROR');
    expect(parseClamdReply('PONG')).toBe('PROTOCOL_ERROR');
    expect(parseClamdReply('')).toBe('PROTOCOL_ERROR');
    expect(sanitizeSignature('Bad<script>"Name"\n')).toBe('BadscriptName');
    expect(sanitizeSignature('<>')).toBe('unknown');
    expect(sanitizeSignature('x'.repeat(500))).toHaveLength(128);
  });
});

describe('clamd scanner (INSTREAM over TCP, fake daemon)', () => {
  const servers: FakeClamd[] = [];
  const start = async (...args: Parameters<typeof startFakeClamd>) => {
    const server = await startFakeClamd(...args);
    servers.push(server);
    return server;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  const scanner = (port: number, extra: { timeoutMs?: number; chunkSize?: number } = {}) =>
    new ClamdScanner({ host: '127.0.0.1', port, timeoutMs: extra.timeoutMs ?? 5000, ...extra });

  it('streams the file in length-prefixed chunks and reads a clean verdict', async () => {
    const fake = await start('scan');
    const bytes = Buffer.from(PDF_BYTES);
    expect(await scanner(fake.port).scan(bytes)).toEqual({ verdict: 'CLEAN' });
    expect(fake.commands).toEqual(['zINSTREAM']);
    expect(fake.payloads[0]!.equals(bytes)).toBe(true);
    expect(await scanner(fake.port).ping()).toBe(true);
    expect(fake.commands).toEqual(['zINSTREAM', 'zPING']);
  });

  it('reports the signature of an infected stream', async () => {
    const fake = await start('scan', { signature: 'Win.Test.EICAR_HDB-1' });
    expect(await scanner(fake.port).scan(EICAR_PDF)).toEqual({
      verdict: 'INFECTED',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('splits the file into chunks (signature across chunk boundaries) and reassembles a split reply', async () => {
    const fake = await start('scan', { splitReply: true });
    const result = await scanner(fake.port, { chunkSize: 7 }).scan(EICAR_PDF);
    expect(result).toEqual({ verdict: 'INFECTED', signature: 'Eicar-Signature' });
    expect(fake.payloads[0]!.equals(EICAR_PDF)).toBe(true);
    const sizes = fake.chunkSizes[0]!;
    expect(sizes).toHaveLength(Math.ceil(EICAR_PDF.length / 7));
    expect(sizes.every((s) => s > 0 && s <= 7)).toBe(true);
    expect(await scanner(fake.port, { chunkSize: 7 }).scan(PDF_BYTES)).toEqual({ verdict: 'CLEAN' });
  });

  it('respects back-pressure on large files (every byte arrives, in default-size chunks)', async () => {
    const fake = await start('scan');
    const big = Buffer.alloc(6 * 1024 * 1024, 0x5a);
    expect(await scanner(fake.port).scan(big)).toEqual({ verdict: 'CLEAN' });
    expect(fake.payloads[0]!.length).toBe(big.length);
    expect(fake.payloads[0]!.equals(big)).toBe(true);
    expect(Math.max(...fake.chunkSizes[0]!)).toBe(64 * 1024);
  });

  it('fails closed on every failure mode', async () => {
    const expectReason = async (promise: Promise<unknown>, reason: ScanFailureReason) => {
      const err = await scanFailure(promise);
      expect(err.reason).toBe(reason);
      expect(err.details).toEqual({ engine: 'clamd', reason });
    };
    await expectReason(scanner(await closedPort()).scan(PDF_BYTES), 'UNREACHABLE');
    expect(await scanner(await closedPort()).ping()).toBe(false);

    const errorFake = await start('engine-error');
    await expectReason(scanner(errorFake.port).scan(PDF_BYTES), 'ENGINE_ERROR');

    const garbage = await start('garbage');
    await expectReason(scanner(garbage.port).scan(PDF_BYTES), 'PROTOCOL_ERROR');

    const dropped = await start('drop');
    await expectReason(scanner(dropped.port).scan(PDF_BYTES), 'CONNECTION_LOST');

    const limited = await start('scan', { sizeLimit: 1000 });
    await expectReason(scanner(limited.port).scan(Buffer.alloc(512 * 1024, 1)), 'SIZE_LIMIT');

    const silent = await start('silent');
    const started = Date.now();
    await expectReason(scanner(silent.port, { timeoutMs: 600 }).scan(PDF_BYTES), 'TIMEOUT');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('AntivirusService', () => {
  it('builds the scanner of ANTIVIRUS_PROVIDER and fails closed on unexpected errors', async () => {
    try {
      expect(createScanner(loadEnv({ ANTIVIRUS_PROVIDER: 'none' }))).toBeNull();
      expect(createScanner(loadEnv({ ANTIVIRUS_PROVIDER: 'sandbox' }))).toBeInstanceOf(SandboxEicarScanner);
      const clamd = createScanner(
        loadEnv({ ANTIVIRUS_PROVIDER: 'clamd', CLAMD_HOST: 'clamav', CLAMD_PORT: '3310' }),
      );
      expect(clamd).toBeInstanceOf(ClamdScanner);
      expect((clamd as ClamdScanner).location).toBe('clamav:3310');

      const service = new AntivirusService(loadEnv({ ANTIVIRUS_PROVIDER: 'sandbox' }));
      expect(service.engine).toBe('sandbox-eicar');
      const clean = await service.scan(PDF_BYTES);
      expect(clean.status).toBe('CLEAN');
      expect(clean.scannedAt).toBeInstanceOf(Date);
      expect(await service.scan(EICAR)).toMatchObject({
        status: 'INFECTED',
        engine: 'sandbox-eicar',
        signature: 'Eicar-Test-Signature',
      });
      service.useScanner({
        engine: 'broken',
        scan: () => Promise.reject(new Error('socket hang up (internal detail)')),
      });
      const err = await scanFailure(service.scan(PDF_BYTES));
      expect(err.details).toEqual({ engine: 'broken', reason: 'ENGINE_ERROR' });
      expect(err.message).not.toContain('internal detail');
      service.useScanner(null);
      expect(await service.scan(EICAR)).toEqual({ status: 'SKIPPED', engine: null, scannedAt: null });
    } finally {
      loadEnv();
    }
  });
});

describe('uploads are scanned before anything is stored', () => {
  let ctx: TestContext;
  let dir: string;
  let owner: Client;
  let ownerId: string;
  let orgId: string;
  let antivirus: AntivirusService;
  let fake: FakeClamd | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dfn-antivirus-test-'));
    ctx = await bootTestApp({ STORAGE_DIR: dir, ANTIVIRUS_PROVIDER: 'sandbox' });
    antivirus = ctx.app.get(AntivirusService);
  });
  afterAll(async () => {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    antivirus.useScanner(new SandboxEicarScanner());
    for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    await resetDatabase(ctx.prisma);
    await ctx.app.get(ReferenceDataService).ensure();
    const reg = await registerUser(ctx, `av-${randomUUID().slice(0, 8)}@example.com`);
    owner = reg.client;
    ownerId = reg.user.id;
    orgId = reg.user.organizations[0].id;
  });
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  const upload = (buffer: Buffer, name = 'facture.pdf') =>
    owner.upload(
      '/v1/documents',
      { kind: 'INVOICE', title: 'Facture fictive' },
      { name, buffer, type: 'application/pdf' },
    );
  const blobCount = () =>
    readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;

  it('records a CLEAN verdict of the sandbox engine on the row and in the DTO', async () => {
    const res = await upload(PDF_BYTES);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.scan).toMatchObject({ status: 'CLEAN', engine: 'sandbox-eicar' });
    expect(typeof res.body.scan.scannedAt).toBe('string');
    expect(res.body.downloadUrl).toBe(`/api/v1/documents/${res.body.id}/download`);
    const row = await ctx.prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ scanStatus: 'CLEAN', scanEngine: 'sandbox-eicar' });
    expect(row.scannedAt).toBeInstanceOf(Date);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'document.uploaded' } });
    expect(audit.metadata).toMatchObject({ scanStatus: 'CLEAN', scanEngine: 'sandbox-eicar' });
    const listed = await owner.get('/v1/documents');
    expect(listed.body[0].scan.status).toBe('CLEAN');
  });

  it('refuses an infected upload with 422: nothing stored, audited with the signature name only', async () => {
    const res = await upload(EICAR_PDF, 'eicar-facture.pdf');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DOCUMENT_INFECTED');
    expect(res.body.details).toEqual({ engine: 'sandbox-eicar', signature: 'Eicar-Test-Signature' });
    expect(await ctx.prisma.document.count()).toBe(0);
    expect(blobCount()).toBe(0);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'document.rejected_infected' },
    });
    expect(audit).toMatchObject({ actorUserId: ownerId, organizationId: orgId, entityId: null });
    expect(audit.metadata).toMatchObject({
      engine: 'sandbox-eicar',
      signature: 'Eicar-Test-Signature',
      kind: 'INVOICE',
      sizeBytes: EICAR_PDF.length,
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).not.toContain('EICAR-STANDARD');
    expect(serialized).not.toContain('eicar-facture');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'document.uploaded' } })).toBe(0);
  });

  it('fails closed with 503 when the scanner is unreachable, and stores nothing', async () => {
    antivirus.useScanner(new ClamdScanner({ host: '127.0.0.1', port: await closedPort(), timeoutMs: 2000 }));
    const res = await upload(PDF_BYTES);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCAN_UNAVAILABLE');
    expect(res.body.details).toEqual({ engine: 'clamd', reason: 'UNREACHABLE' });
    expect(await ctx.prisma.document.count()).toBe(0);
    expect(blobCount()).toBe(0);
  });

  it('uses the clamd verdict end to end (clean stored, infected refused)', async () => {
    fake = await startFakeClamd('scan', { signature: 'Win.Test.EICAR_HDB-1' });
    antivirus.useScanner(new ClamdScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: 5000 }));
    const clean = await upload(PDF_BYTES);
    expect(clean.status, JSON.stringify(clean.body)).toBe(201);
    expect(clean.body.scan).toMatchObject({ status: 'CLEAN', engine: 'clamd' });
    const infected = await upload(EICAR_PDF);
    expect(infected.status).toBe(422);
    expect(infected.body.details).toEqual({ engine: 'clamd', signature: 'Win.Test.EICAR_HDB-1' });
    expect(await ctx.prisma.document.count()).toBe(1);
    expect(blobCount()).toBe(1);
  });

  it('records SKIPPED (no engine, no date) when scanning is disabled', async () => {
    antivirus.useScanner(null);
    const res = await upload(EICAR_PDF);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.scan).toEqual({ status: 'SKIPPED', engine: null, scannedAt: null });
    const row = await ctx.prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ scanStatus: 'SKIPPED', scanEngine: null, scannedAt: null });
  });

  it('never serves a document flagged INFECTED (no link, 409, audited)', async () => {
    const res = await upload(PDF_BYTES);
    await ctx.prisma.document.update({ where: { id: res.body.id }, data: { scanStatus: 'INFECTED' } });
    const listed = await owner.get('/v1/documents');
    expect(listed.body[0]).toMatchObject({ scan: { status: 'INFECTED' }, downloadUrl: null });
    const download = await owner.get(`/v1/documents/${res.body.id}/download`);
    expect(download.status).toBe(409);
    expect(download.body.code).toBe('DOCUMENT_INFECTED');
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'document.download_refused', entityId: res.body.id },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'document.downloaded', entityId: res.body.id } }),
    ).toBe(0);
  });
});
