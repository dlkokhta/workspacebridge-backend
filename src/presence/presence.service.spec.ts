import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  let service: PresenceService;

  beforeEach(() => {
    service = new PresenceService();
  });

  it('reports a user offline when they have no sockets', () => {
    expect(service.isOnline('user-1')).toBe(false);
    expect(service.getSocketIds('user-1')).toEqual([]);
  });

  it('reports a user online after adding a socket', () => {
    service.add('user-1', 'socket-a');
    expect(service.isOnline('user-1')).toBe(true);
    expect(service.getSocketIds('user-1')).toEqual(['socket-a']);
  });

  it('keeps a user online until their last socket disconnects', () => {
    service.add('user-1', 'socket-a');
    service.add('user-1', 'socket-b');

    service.remove('user-1', 'socket-a');
    expect(service.isOnline('user-1')).toBe(true);

    service.remove('user-1', 'socket-b');
    expect(service.isOnline('user-1')).toBe(false);
  });

  it('does not double-count the same socket id', () => {
    service.add('user-1', 'socket-a');
    service.add('user-1', 'socket-a');
    expect(service.getSocketIds('user-1')).toEqual(['socket-a']);
  });

  it('ignores removing a socket that was never tracked', () => {
    service.add('user-1', 'socket-a');
    service.remove('user-1', 'socket-x');
    expect(service.isOnline('user-1')).toBe(true);

    service.remove('user-2', 'socket-z');
    expect(service.isOnline('user-2')).toBe(false);
  });
});
