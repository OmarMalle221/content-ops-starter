import { SANDBOX_SCAN_ENGINE } from '@dfn/shared';
import type { ScanResult, Scanner } from './scanner';

/**
 * The EICAR anti-malware test string (68 bytes, harmless by design: every antivirus engine
 * reports it so that detection can be tested without real malware). Assembled from two halves so
 * that this source file is not itself flagged by a workstation antivirus.
 */
export const EICAR_TEST_STRING = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR',
  '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
].join('');

const EICAR_BYTES = Buffer.from(EICAR_TEST_STRING, 'latin1');

/** Signature reported for the EICAR test string (the name ClamAV uses). */
export const EICAR_SIGNATURE = 'Eicar-Test-Signature';

/**
 * SIMULATED antivirus of the sandbox (ANTIVIRUS_PROVIDER=sandbox): it reports INFECTED when the
 * EICAR test string appears anywhere in the file and CLEAN otherwise. It detects NOTHING else —
 * it exists to exercise the rejection path end to end, and is labelled as a simulation wherever
 * its verdicts are shown. Real scanning needs ANTIVIRUS_PROVIDER=clamd.
 */
export class SandboxEicarScanner implements Scanner {
  readonly engine = SANDBOX_SCAN_ENGINE;

  async scan(bytes: Buffer): Promise<ScanResult> {
    return bytes.includes(EICAR_BYTES)
      ? { verdict: 'INFECTED', signature: EICAR_SIGNATURE }
      : { verdict: 'CLEAN' };
  }
}
