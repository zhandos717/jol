import { describe, expect, it } from 'vitest';
import { TRIP_TRANSITIONS, canBook, suggestSeatPrice } from './rules.js';

describe('intercity rules', () => {
  it('never overbooks a car', () => {
    expect(canBook(4, 2, 2)).toBe(true);
    expect(canBook(4, 3, 2)).toBe(false);
    expect(canBook(4, 0, 0)).toBe(false);
  });

  it('suggests ~10 KZT per km with a floor', () => {
    expect(suggestSeatPrice(1230)).toBe(12300);
    expect(suggestSeatPrice(40)).toBe(1000);
  });

  it('lets bookings change only before departure', () => {
    expect(TRIP_TRANSITIONS.open).toContain('departed');
    expect(TRIP_TRANSITIONS.departed).not.toContain('cancelled');
  });
});
