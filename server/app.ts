import { defineRoom, defineServer } from '@colyseus/core';
import { ROOM_NAME } from '../src/net/protocol';
import { DuelRoom } from './DuelRoom';

export function createServer() {
  return defineServer({
    rooms: {
      // Practice rooms never match with public ones.
      [ROOM_NAME]: defineRoom(DuelRoom).filterBy(['practice']),
    },
  });
}
