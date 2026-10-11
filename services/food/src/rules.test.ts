import { describe, expect, it } from 'vitest';
import { canMove, courierTariffFor, nextCourierAttempt, priceCart, type MenuItem } from './rules.js';

const menu = new Map<string, MenuItem>([
  ['pizza', { id: 'pizza', name: 'Пицца', price: 3400, isAvailable: true }],
  ['tea', { id: 'tea', name: 'Чай', price: 1200, isAvailable: true }],
  ['soldout', { id: 'soldout', name: 'Бешбармак', price: 4200, isAvailable: false }],
]);

describe('priceCart', () => {
  it('prices from the menu, not from the client', () => {
    const { lines, total } = priceCart(menu, [{ itemId: 'pizza', qty: 2 }, { itemId: 'tea', qty: 1 }]);
    expect(total).toBe(8000);
    expect(lines[0]).toEqual({ itemId: 'pizza', name: 'Пицца', price: 3400, qty: 2 });
  });

  it('rejects empty carts, foreign or sold-out dishes, duplicates and silly quantities', () => {
    expect(() => priceCart(menu, [])).toThrow('Корзина пуста');
    expect(() => priceCart(menu, [{ itemId: 'other-restaurant', qty: 1 }])).toThrow('не найдено');
    expect(() => priceCart(menu, [{ itemId: 'soldout', qty: 1 }])).toThrow('нет в наличии');
    expect(() => priceCart(menu, [{ itemId: 'tea', qty: 1 }, { itemId: 'tea', qty: 2 }])).toThrow('дважды');
    expect(() => priceCart(menu, [{ itemId: 'tea', qty: 0 }])).toThrow('Количество');
    expect(() => priceCart(menu, [{ itemId: 'tea', qty: 21 }])).toThrow('Количество');
  });
});

describe('courier choice', () => {
  it('sends a bike nearby and a car further away', () => {
    expect(courierTariffFor(3)).toBe('courier_bike');
    expect(courierTariffFor(8)).toBe('courier_car');
  });

  it('falls back to a car once, then gives up', () => {
    expect(nextCourierAttempt(1)).toBe('courier_car');
    expect(nextCourierAttempt(2)).toBeNull();
  });
});

describe('food order lifecycle', () => {
  it('lets the courier pick up before the kitchen presses "ready"', () => {
    expect(canMove('cooking', 'delivering')).toBe(true);
  });

  it('never cancels food that is already on the way', () => {
    expect(canMove('delivering', 'cancelled')).toBe(false);
  });
});
