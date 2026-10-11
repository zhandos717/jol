/** Server-Sent Events wire format: one `event:` + `data:` block per message, blank line terminated. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const SSE_PING = ': ping\n\n';
