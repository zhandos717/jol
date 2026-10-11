import type { OrderStatus } from '@jol/contracts';

/**
 * Order lifecycle. Every status change goes through `canTransition`, and the repository
 * applies it with `WHERE status = ANY(from)`, so concurrent actors (two drivers accepting,
 * passenger cancelling while a driver accepts) cannot both win.
 *
 *   scheduled ─► searching ─► accepted ─► arrived ─► in_progress ─► done
 *       │            │  └──► no_drivers     │
 *       └────────────┴──────► cancelled ◄───┘
 */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  scheduled: ['searching', 'cancelled'],
  searching: ['accepted', 'cancelled', 'no_drivers'],
  accepted: ['arrived', 'cancelled'],
  arrived: ['in_progress', 'cancelled'],
  in_progress: ['done'],
  done: [],
  cancelled: [],
  no_drivers: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function sourcesOf(to: OrderStatus): OrderStatus[] {
  return (Object.keys(TRANSITIONS) as OrderStatus[]).filter(from => canTransition(from, to));
}

export type DriverAction = 'arrived' | 'start' | 'finish';

export const DRIVER_ACTIONS: Record<DriverAction, OrderStatus> = {
  arrived: 'arrived',
  start: 'in_progress',
  finish: 'done',
};
