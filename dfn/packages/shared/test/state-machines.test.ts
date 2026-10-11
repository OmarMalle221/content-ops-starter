import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  disputeMachine,
  milestoneMachine,
  transactionMachine,
  transferMachine,
} from '../src/state-machines';

describe('transaction state machine', () => {
  it('follows the nominal Protect path', () => {
    const path = [
      'DRAFT',
      'PENDING_ACCEPTANCE',
      'ACCEPTED',
      'AWAITING_FUNDING',
      'FUNDED',
      'IN_PROGRESS',
      'SETTLED',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(transactionMachine.canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('refuses to skip funding', () => {
    expect(transactionMachine.canTransition('ACCEPTED', 'IN_PROGRESS')).toBe(false);
    expect(() => transactionMachine.assertTransition('ACCEPTED', 'SETTLED')).toThrow(InvalidTransitionError);
  });

  it('only allows disputes on funded transactions', () => {
    expect(transactionMachine.canTransition('AWAITING_FUNDING', 'DISPUTED')).toBe(false);
    expect(transactionMachine.canTransition('FUNDED', 'DISPUTED')).toBe(true);
    expect(transactionMachine.canTransition('IN_PROGRESS', 'DISPUTED')).toBe(true);
  });

  it('treats settled / refunded / cancelled / expired as terminal', () => {
    for (const s of ['SETTLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(transactionMachine.isTerminal(s)).toBe(true);
    }
  });
});

describe('milestone state machine', () => {
  it('requires approval before release', () => {
    expect(milestoneMachine.canTransition('SUBMITTED', 'RELEASED')).toBe(false);
    expect(milestoneMachine.canTransition('APPROVED', 'RELEASED')).toBe(true);
  });
  it('allows resubmission after changes requested', () => {
    expect(milestoneMachine.canTransition('CHANGES_REQUESTED', 'SUBMITTED')).toBe(true);
  });
});

describe('dispute state machine', () => {
  it('supports appeal and re-decision', () => {
    expect(disputeMachine.canTransition('DECIDED', 'APPEALED')).toBe(true);
    expect(disputeMachine.canTransition('APPEALED', 'DECIDED')).toBe(true);
    expect(disputeMachine.canTransition('OPEN', 'DECIDED')).toBe(false);
  });
});

describe('transfer state machine', () => {
  it('matches CREATED → QUOTED → AUTHORIZED → PROCESSING → SETTLED', () => {
    expect(transferMachine.canTransition('CREATED', 'QUOTED')).toBe(true);
    expect(transferMachine.canTransition('QUOTED', 'AUTHORIZED')).toBe(true);
    expect(transferMachine.canTransition('AUTHORIZED', 'PROCESSING')).toBe(true);
    expect(transferMachine.canTransition('PROCESSING', 'SETTLED')).toBe(true);
    expect(transferMachine.canTransition('CREATED', 'SETTLED')).toBe(false);
  });
});
