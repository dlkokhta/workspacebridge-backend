import { Injectable } from '@nestjs/common';

/**
 * In-memory registry of which users currently hold an open socket connection.
 * A user counts as "online" while they have at least one socket; multiple tabs
 * or devices are tracked by socket id so a user stays online until their last
 * connection closes. Used to decide whether a notification can be pushed live
 * or must fall back to email.
 *
 * This state is per-process: it does not survive a restart and is not shared
 * across multiple backend instances. That is fine for a single-instance
 * deployment; switch to a Redis-backed adapter if the API is ever scaled out.
 */
@Injectable()
export class PresenceService {
  private readonly socketsByUser = new Map<string, Set<string>>();

  add(userId: string, socketId: string): void {
    const sockets = this.socketsByUser.get(userId);
    if (sockets) {
      sockets.add(socketId);
    } else {
      this.socketsByUser.set(userId, new Set([socketId]));
    }
  }

  remove(userId: string, socketId: string): void {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.socketsByUser.delete(userId);
    }
  }

  isOnline(userId: string): boolean {
    return this.socketsByUser.has(userId);
  }

  getSocketIds(userId: string): string[] {
    return [...(this.socketsByUser.get(userId) ?? [])];
  }
}
