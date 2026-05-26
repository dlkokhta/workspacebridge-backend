import type { Socket } from 'socket.io';

// Sockets that have completed the JWT handshake stamp the access token's
// `exp` claim (seconds since epoch) on themselves so we can drop the
// connection when the access token expires. Without this, an attacker
// who managed to obtain a still-open socket would keep that access
// indefinitely past the token's natural lifetime.
export interface ExpirableSocket extends Socket {
  tokenExpiresAt?: number;
}

// Returns true when the socket's recorded token expiry has passed (or is
// missing, which means the socket was never properly authenticated).
export const isSocketTokenExpired = (
  client: ExpirableSocket,
  now: Date = new Date(),
): boolean => {
  if (!client.tokenExpiresAt) return true;
  return now.getTime() / 1000 >= client.tokenExpiresAt;
};

// Convenience: enforce expiry at the start of each @SubscribeMessage
// handler. Returns true if the request should be dropped (also disconnects
// the socket as a side effect). Typical use:
//   if (rejectExpiredSocket(client)) return;
export const rejectExpiredSocket = (client: ExpirableSocket): boolean => {
  if (!isSocketTokenExpired(client)) return false;
  client.emit('error', { message: 'Session expired. Please reconnect.' });
  client.disconnect();
  return true;
};
