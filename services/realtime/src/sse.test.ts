import { describe, expect, it } from 'vitest';
import { sseFrame } from './sse.js';

describe('sseFrame', () => {
  it('serialises one event per frame', () => {
    expect(sseFrame('order', { id: 1 })).toBe('event: order\ndata: {"id":1}\n\n');
  });

  it('keeps multi-line payloads on a single data line', () => {
    expect(sseFrame('trip', { comment: 'a\nb' }).split('\n').filter(l => l.startsWith('data:'))).toHaveLength(1);
  });
});
