/**
 * Records of the SIMULATED payment partner (MockPaymentProvider) — SIMULATION ONLY.
 *
 * This is the fake partner's own state (the instructions, transfers and account statement a real partner
 * would keep on its side), never TrustCargo's books: TrustCargo records what it sent and what the partner
 * reported in its own tables (`Db`), and reconciliation compares both sides. No real funds exist.
 *
 * - MemorySimulatedPartnerStore (default): per process, lost on restart.
 * - PostgresSimulatedPartnerStore (src/server/adapters/postgres/): schema `trustcargo_sim`, survives
 *   restarts and is shared by several instances. The fake partner is an external system: its writes never
 *   join the caller's unit of work.
 *
 * Idempotency: one instruction per instruction idempotency key, one transfer per transfer idempotency key.
 * A known key returns the record stored for it, unchanged.
 */
import type { Money } from '@/domain/money';
import { ProviderError, type FundingStatus, type ProviderPayoutStatus, type StatementLine } from '@/server/ports/payment-provider';

export type TransferKind = 'PAYOUT' | 'REFUND';

export interface SimulatedInstruction {
    reference: string;
    idempotencyKey: string;
    amount: Money;
    status: FundingStatus;
}

export interface SimulatedTransfer {
    reference: string;
    kind: TransferKind;
    idempotencyKey: string;
    amount: Money;
    status: ProviderPayoutStatus;
}

export interface SimulatedPartnerStore {
    /** Stores the instruction unless its idempotency key is known; returns the stored instruction either way. */
    createInstruction(instruction: SimulatedInstruction): Promise<SimulatedInstruction>;
    getInstruction(reference: string): Promise<SimulatedInstruction | undefined>;
    /** Sets the status and appends `statementLine` (when given) atomically. Unknown reference → ProviderError. */
    setInstructionStatus(reference: string, status: FundingStatus, statementLine?: StatementLine): Promise<void>;
    /** Stores the transfer unless its idempotency key is known; returns the stored transfer either way. */
    createTransfer(transfer: SimulatedTransfer): Promise<SimulatedTransfer>;
    getTransfer(reference: string): Promise<SimulatedTransfer | undefined>;
    /** Sets the status and appends `statementLine` (when given) atomically. Unknown reference → ProviderError. */
    setTransferStatus(reference: string, status: ProviderPayoutStatus, statementLine?: StatementLine): Promise<void>;
    /** Every transfer, in creation order. */
    listTransfers(): Promise<SimulatedTransfer[]>;
    appendStatementLine(line: StatementLine): Promise<void>;
    /** Statement lines with `from <= occurredAt <= to`, in the order they were recorded. */
    statement(range: { from: string; to: string }): Promise<StatementLine[]>;
}

const copyInstruction = (i: SimulatedInstruction): SimulatedInstruction => ({ ...i, amount: { ...i.amount } });
const copyTransfer = (t: SimulatedTransfer): SimulatedTransfer => ({ ...t, amount: { ...t.amount } });

/** In-process store: the behaviour of the mock partner before persistence (demo with in-memory data, tests). */
export class MemorySimulatedPartnerStore implements SimulatedPartnerStore {
    private readonly instructions = new Map<string, SimulatedInstruction>();
    private readonly instructionsByKey = new Map<string, string>();
    private readonly transfers = new Map<string, SimulatedTransfer>();
    private readonly transfersByKey = new Map<string, string>();
    private readonly lines: StatementLine[] = [];

    async createInstruction(instruction: SimulatedInstruction): Promise<SimulatedInstruction> {
        const existing = this.instructionsByKey.get(instruction.idempotencyKey);
        if (existing) return copyInstruction(this.instructions.get(existing)!);
        this.instructions.set(instruction.reference, copyInstruction(instruction));
        this.instructionsByKey.set(instruction.idempotencyKey, instruction.reference);
        return copyInstruction(instruction);
    }

    async getInstruction(reference: string): Promise<SimulatedInstruction | undefined> {
        const instruction = this.instructions.get(reference);
        return instruction && copyInstruction(instruction);
    }

    async setInstructionStatus(reference: string, status: FundingStatus, statementLine?: StatementLine): Promise<void> {
        const instruction = this.instructions.get(reference);
        if (!instruction) throw new ProviderError('Unknown instruction', false);
        instruction.status = status;
        if (statementLine) this.lines.push({ ...statementLine });
    }

    async createTransfer(transfer: SimulatedTransfer): Promise<SimulatedTransfer> {
        const existing = this.transfersByKey.get(transfer.idempotencyKey);
        if (existing) return copyTransfer(this.transfers.get(existing)!);
        this.transfers.set(transfer.reference, copyTransfer(transfer));
        this.transfersByKey.set(transfer.idempotencyKey, transfer.reference);
        return copyTransfer(transfer);
    }

    async getTransfer(reference: string): Promise<SimulatedTransfer | undefined> {
        const transfer = this.transfers.get(reference);
        return transfer && copyTransfer(transfer);
    }

    async setTransferStatus(reference: string, status: ProviderPayoutStatus, statementLine?: StatementLine): Promise<void> {
        const transfer = this.transfers.get(reference);
        if (!transfer) throw new ProviderError('Unknown transfer', false);
        transfer.status = status;
        if (statementLine) this.lines.push({ ...statementLine });
    }

    async listTransfers(): Promise<SimulatedTransfer[]> {
        return [...this.transfers.values()].map(copyTransfer);
    }

    async appendStatementLine(line: StatementLine): Promise<void> {
        this.lines.push({ ...line });
    }

    async statement(range: { from: string; to: string }): Promise<StatementLine[]> {
        return this.lines.filter((l) => l.occurredAt >= range.from && l.occurredAt <= range.to).map((l) => ({ ...l }));
    }
}
