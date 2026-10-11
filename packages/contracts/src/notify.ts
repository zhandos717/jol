/**
 * Fire-and-forget notifications to connected apps (core NATS, not persisted).
 * `realtime` subscribes to `notify.<role>.<id>` per open SSE stream and forwards `{ event, data }` as-is.
 */
export type Audience = 'client' | 'driver' | 'restaurant';

export type NotifyEvent = 'order' | 'offer' | 'offer_expired' | 'driver_location' | 'trip' | 'food';

export interface Notification {
  event: NotifyEvent;
  data: unknown;
}

export const notifySubject = (role: Audience, id: string) => `notify.${role}.${id}`;
