import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { ClamdScanner } from './clamd-scanner';
import { SandboxEicarScanner } from './sandbox-scanner';
import { ScanUnavailableError, type Scanner } from './scanner';

/** Verdict recorded on Document.scanStatus / scanEngine / scannedAt. */
export interface ScanOutcome {
  status: 'CLEAN' | 'INFECTED' | 'SKIPPED';
  /** null when scanning is disabled (SKIPPED). */
  engine: string | null;
  /** Signature name (INFECTED only). */
  signature?: string;
  /** null when nothing was scanned (SKIPPED). */
  scannedAt: Date | null;
}

/** Scanner selected by ANTIVIRUS_PROVIDER ("none" → null: uploads are stored as SKIPPED). */
export function createScanner(env: Env): Scanner | null {
  switch (env.ANTIVIRUS_PROVIDER) {
    case 'none':
      return null;
    case 'sandbox':
      return new SandboxEicarScanner();
    case 'clamd':
      return new ClamdScanner({
        host: env.CLAMD_HOST,
        port: env.CLAMD_PORT,
        timeoutMs: env.ANTIVIRUS_TIMEOUT_MS,
      });
  }
}

/**
 * Antivirus scanning of uploads, fail closed: when a scanner is configured, an upload is stored
 * only after a CLEAN verdict; INFECTED is refused (422 DOCUMENT_INFECTED, by the caller) and any
 * failure to obtain a verdict is refused too (503 SCAN_UNAVAILABLE). Only ANTIVIRUS_PROVIDER=none
 * stores without scanning, and records it (SKIPPED).
 *
 * The "sandbox" provider is a simulation that only recognises the EICAR test file: the startup
 * log, the documentation and the interface say so — it is never presented as real protection.
 */
@Injectable()
export class AntivirusService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Antivirus');
  private scanner: Scanner | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.scanner = createScanner(env);
  }

  get provider(): Env['ANTIVIRUS_PROVIDER'] {
    return this.env.ANTIVIRUS_PROVIDER;
  }

  /** Engine of the active scanner, null when scanning is disabled. */
  get engine(): string | null {
    return this.scanner?.engine ?? null;
  }

  /** Scans `bytes`. Throws ScanUnavailableError (503) when no verdict can be obtained. */
  async scan(bytes: Buffer): Promise<ScanOutcome> {
    const scanner = this.scanner;
    if (!scanner) return { status: 'SKIPPED', engine: null, scannedAt: null };
    try {
      const result = await scanner.scan(bytes);
      return {
        status: result.verdict,
        engine: scanner.engine,
        ...(result.verdict === 'INFECTED' ? { signature: result.signature ?? 'unknown' } : {}),
        scannedAt: new Date(),
      };
    } catch (err) {
      const unavailable =
        err instanceof ScanUnavailableError ? err : new ScanUnavailableError(scanner.engine, 'ENGINE_ERROR');
      this.logger.warn(`scan unavailable (engine=${unavailable.engine}, reason=${unavailable.reason})`);
      throw unavailable;
    }
  }

  onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test') return;
    const scanner = this.scanner;
    if (!scanner) {
      this.logger.warn('antivirus provider=none: uploads are stored WITHOUT scanning (scanStatus SKIPPED)');
    } else if (scanner instanceof SandboxEicarScanner) {
      this.logger.warn(
        'antivirus provider=sandbox: SIMULATION that only detects the EICAR test file — not malware protection',
      );
    } else if (scanner instanceof ClamdScanner) {
      // Not awaited: an unreachable daemon must not delay the start (ping never throws).
      void scanner.ping().then((ok) => {
        if (ok) this.logger.log(`antivirus provider=clamd at ${scanner.location}: ok`);
        else
          this.logger.error(
            `antivirus provider=clamd at ${scanner.location}: UNAVAILABLE — uploads answer 503 SCAN_UNAVAILABLE until it recovers`,
          );
      });
    }
  }

  /** Test seam: replaces the scanner (null = scanning disabled). */
  useScanner(scanner: Scanner | null): void {
    this.scanner = scanner;
  }
}
