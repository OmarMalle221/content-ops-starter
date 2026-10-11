export class InvalidTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid ${entity} transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface StateMachine<S extends string> {
  readonly entity: string;
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  readonly terminal: readonly S[];
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;
  isTerminal(state: S): boolean;
  nextStates(from: S): readonly S[];
}

export function defineStateMachine<S extends string>(
  entity: string,
  transitions: Record<S, readonly S[]>,
): StateMachine<S> {
  const terminal = (Object.keys(transitions) as S[]).filter((s) => transitions[s].length === 0);
  return {
    entity,
    transitions,
    terminal,
    canTransition(from, to) {
      return transitions[from]?.includes(to) ?? false;
    },
    assertTransition(from, to) {
      if (!this.canTransition(from, to)) throw new InvalidTransitionError(entity, from, to);
    },
    isTerminal(state) {
      return terminal.includes(state);
    },
    nextStates(from) {
      return transitions[from] ?? [];
    },
  };
}
