import { NEW_USER_RATING } from '@jol/contracts';

export function averageRating(sum: number, count: number): number {
  if (count <= 0) return NEW_USER_RATING;
  return Math.round((sum / count) * 100) / 100;
}
