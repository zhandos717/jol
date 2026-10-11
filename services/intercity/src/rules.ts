export type TripStatus = 'open' | 'departed' | 'done' | 'cancelled';

export const TRIP_TRANSITIONS: Record<TripStatus, readonly TripStatus[]> = {
  open: ['departed', 'cancelled'],
  departed: ['done'],
  done: [],
  cancelled: [],
};

export const MAX_SEATS = 7;
export const MIN_SEAT_PRICE = 500;
/** Trips "from Almaty" match departures anywhere within the agglomeration. */
export const SAME_CITY_KM = 25;
/** Suggested seat price: ~10 KZT per road km, rounded to 100, never below 1000. */
export const suggestSeatPrice = (km: number) => Math.max(1000, Math.round((km * 10) / 100) * 100);

export function canBook(seatsTotal: number, seatsTaken: number, requested: number): boolean {
  return requested >= 1 && seatsTaken + requested <= seatsTotal;
}
