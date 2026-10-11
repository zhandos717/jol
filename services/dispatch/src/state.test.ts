import { describe, expect, it } from 'vitest';
import { ACTIVE_ORDER_STATUSES } from '@jol/contracts';
import { canTransition, sourcesOf, TRANSITIONS } from './state.js';

describe('order state machine', () => {
  it('follows the happy path', () => {
    const path = ['scheduled', 'searching', 'accepted', 'arrived', 'in_progress', 'done'] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });

  it('cannot cancel a ride that is already under way', () => {
    expect(canTransition('in_progress', 'cancelled')).toBe(false);
  });

  it('treats final statuses as terminal', () => {
    for (const s of ['done', 'cancelled', 'no_drivers'] as const) expect(TRANSITIONS[s]).toEqual([]);
  });

  it('every active status can reach a final one', () => {
    for (const s of ACTIVE_ORDER_STATUSES) expect(TRANSITIONS[s].length).toBeGreaterThan(0);
  });

  it('derives guard sets for conditional updates', () => {
    expect(sourcesOf('cancelled').sort()).toEqual(['accepted', 'arrived', 'scheduled', 'searching']);
    expect(sourcesOf('accepted')).toEqual(['searching']);
  });
});
