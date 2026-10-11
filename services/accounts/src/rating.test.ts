import { describe, expect, it } from 'vitest';
import { averageRating } from './rating.js';

describe('averageRating', () => {
  it('gives new users a full rating', () => {
    expect(averageRating(0, 0)).toBe(5);
  });

  it('averages and rounds to two decimals', () => {
    expect(averageRating(14, 3)).toBe(4.67);
    expect(averageRating(9, 2)).toBe(4.5);
  });
});
