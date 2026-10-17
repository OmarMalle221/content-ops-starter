import { createConnection, type Socket } from 'node:net';
import {
  ScanUnavailableError,
  sanitizeSignature,
  type ScanFailureReason,
  type ScanResult,
  type Scanner,
} from './scanner';

export interface ClamdOptions {
  host: string;
  port: number;
  /** Deadline of the whole exchange: connection, upload of the file and verdict. */
  timeoutMs: number;
  /** INSTREAM chunk size (default 64 KiB). */
  chunkSize?: number;
}

const DEFAULT_CHUNK_BYTES = 64 * 1024;
/** clamd answers with one short line: anything longer is not clamd. */
const MAX_REPLY_BYTES = 4096;

/** Parsed clamd answer: a verdict, or the reason no verdict was obtained. */
export type ClamdReply = ScanResult | ScanFailureReason;

/** Parses a clamd INSTREAM reply ("stream: OK", "stream: <signature> FOUND", "<message> ERROR"). */
export function parseClamdReply(reply: string): ClamdReply {
  // IDSESSION mode prefixes replies with "<id>: "; replies end with NUL (z-commands) or newline.
  const text = reply
    .replace(/\0/g, '')
    .trim()
    .replace(/^\d+: /, '');
  if (text === 'stream: OK') return { verdict: 'CLEAN' };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { verdict: 'INFECTED', signature: sanitizeSignature(found[1]!) };
  if (/size limit exceeded/i.test(text)) return 'SIZE_LIMIT';
  if (/ERROR$/.test(text)) return 'ENGINE_ERROR';
  return 'PROTOCOL_ERROR';
}

/**
 * ClamAV daemon (ANTIVIRUS_PROVIDER=clamd) over TCP, INSTREAM protocol:
 *
 *  - `zINSTREAM\0`, then the file as chunks — each prefixed with its length as a 4-byte
 *    big-endian integer — then a zero-length chunk; clamd answers one NUL-terminated line;
 *  - writes respect socket back-pressure, so a large file never piles up in memory twice;
 *  - one deadline (ANTIVIRUS_TIMEOUT_MS) covers connection, upload and verdict;
 *  - every failure (refused connection, timeout, "INSTREAM size limit exceeded", engine error,
 *    reset, unparsable answer) rejects with ScanUnavailableError: the upload is then refused.
 *
 * clamd's StreamMaxLength (25 MB by default) must be at least MAX_UPLOAD_MB, or larger uploads are
 * refused with SCAN_UNAVAILABLE (SIZE_LIMIT).
 */
export class ClamdScanner implements Scanner {
  readonly engine = 'clamd';

  constructor(private readonly options: ClamdOptions) {}

  /** host:port of the daemon (no credentials exist in this protocol). */
  get location(): string {
    return `${this.options.host}:${this.options.port}`;
  }

  async scan(bytes: Buffer): Promise<ScanResult> {
    const parsed = parseClamdReply(await this.exchange('zINSTREAM', bytes));
    if (typeof parsed === 'string') throw new ScanUnavailableError(this.engine, parsed);
    return parsed;
  }

  /** `zPING` → `PONG`: the daemon is reachable and answering. Never throws. */
  async ping(): Promise<boolean> {
    try {
      return (await this.exchange('zPING', null)).trim() === 'PONG';
    } catch {
      return false;
    }
  }

  /** Sends one command (and the INSTREAM payload) and resolves with clamd's answer line. */
  private exchange(command: 'zINSTREAM' | 'zPING', payload: Buffer | null): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      const received: Buffer[] = [];
      let receivedBytes = 0;
      let connected = false;
      let done = false;
      let wakeWriter: (() => void) | null = null;
      const wake = () => {
        const resume = wakeWriter;
        wakeWriter = null;
        resume?.();
      };

      const finish = (outcome: { reply: string } | { reason: ScanFailureReason }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wake();
        socket.destroy();
        if ('reply' in outcome) resolve(outcome.reply);
        else reject(new ScanUnavailableError(this.engine, outcome.reason));
      };
      // An answer received before the connection dropped wins: clamd replies "INSTREAM size
      // limit exceeded. ERROR" and closes while the client may still be writing.
      const closed = () =>
        finish(
          receivedBytes > 0
            ? { reply: Buffer.concat(received, receivedBytes).toString('utf8') }
            : { reason: connected ? 'CONNECTION_LOST' : 'UNREACHABLE' },
        );
      const timer = setTimeout(() => finish({ reason: 'TIMEOUT' }), this.options.timeoutMs);

      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
        receivedBytes += chunk.length;
        const all = Buffer.concat(received, receivedBytes);
        const end = all.indexOf(0);
        if (end !== -1) finish({ reply: all.subarray(0, end).toString('utf8') });
        else if (receivedBytes > MAX_REPLY_BYTES) finish({ reason: 'PROTOCOL_ERROR' });
      });
      socket.on('end', closed);
      socket.on('close', closed);
      // Write errors (EPIPE, ECONNRESET) land here too; the listener also prevents a crash.
      socket.on('error', closed);
      socket.on('drain', wake);
      socket.on('connect', () => {
        connected = true;
        void this.send(socket, command, payload, {
          isDone: () => done,
          drained: () =>
            new Promise<void>((resume) => {
              wakeWriter = resume;
            }),
        });
      });
    });
  }

  private async send(
    socket: Socket,
    command: string,
    payload: Buffer | null,
    flow: { isDone: () => boolean; drained: () => Promise<void> },
  ): Promise<void> {
    let writable = socket.write(Buffer.from(`${command}\0`, 'latin1'));
    if (!payload) return;
    const chunkSize = this.options.chunkSize ?? DEFAULT_CHUNK_BYTES;
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      if (!writable) await flow.drained();
      if (flow.isDone()) return;
      const chunk = payload.subarray(offset, offset + chunkSize);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(chunk.length, 0);
      socket.write(length);
      writable = socket.write(chunk);
    }
    if (!writable) await flow.drained();
    if (flow.isDone()) return;
    socket.write(Buffer.alloc(4)); // zero-length chunk: end of the stream
  }
}
