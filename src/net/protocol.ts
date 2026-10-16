import { ABILITY_SLOTS, CHAMPIONS, type AbilitySlot } from '../sim/defs';
import type { Vec } from '../sim/math';
import type { Order, PlayerCommand, Projectile, Shadow, SimEvent, Team, Unit } from '../sim/world';

// Messages shared by the Colyseus server and the browser client. The server is
// authoritative: clients send numbered CommandMessages, the server sends a Snapshot every
// tick, telling each client which of its commands it has applied so far.

export const ROOM_NAME = 'duel';
/** 2567 is the Colyseus default, so pick a neighbour to coexist with other Colyseus projects. */
export const DEFAULT_PORT = 2568;

export const MSG = {
  /** client → server: a CommandMessage */
  command: 'cmd',
  /** server → client: Welcome, once after joining */
  welcome: 'welcome',
  /** server → client: Snapshot, every tick */
  snapshot: 'snap',
} as const;

export interface JoinOptions {
  /** Solo room against the server-side practice bot. */
  practice?: boolean;
  /** Champion id from PLAYABLE; anything else falls back to the first. */
  champ?: string;
}

export interface Welcome {
  unitId: number;
  tickRate: number;
}

/**
 * A command numbered by the client. `cmd` is omitted for calibration pings, which the
 * server only acknowledges; that keeps the client's tick offset fresh while idle.
 */
export interface CommandMessage {
  seq: number;
  cmd?: PlayerCommand;
}

/** Per-client part of a snapshot. Only you see your own order, so it never leaks to the opponent. */
export interface OwnState {
  /** Highest command seq the server has received from you (-1 if none). */
  ack: number;
  /** Server tick whose step first simulated with that command. */
  ackTick: number;
  order: Order;
}

export interface UnitSnapshot {
  id: number;
  team: Team;
  champ: string;
  spawn: Vec;
  pos: Vec;
  facing: number;
  hp: number;
  mana: number;
  attackCooldown: number;
  windup: Unit['windup'];
  cast: Unit['cast'];
  dash: Unit['dash'];
  cooldowns: Unit['cooldowns'];
  statuses: Unit['statuses'];
  respawnIn: number;
}

export interface Snapshot {
  tick: number;
  units: UnitSnapshot[];
  projectiles: Projectile[];
  shadows: Shadow[];
  /** Events that happened during this tick. */
  events: SimEvent[];
  you?: OwnState;
}

export function toUnitSnapshot(u: Unit): UnitSnapshot {
  return {
    id: u.id,
    team: u.team,
    champ: u.def.id,
    spawn: u.spawn,
    pos: u.pos,
    facing: u.facing,
    hp: u.hp,
    mana: u.mana,
    attackCooldown: u.attackCooldown,
    windup: u.windup,
    cast: u.cast,
    dash: u.dash,
    cooldowns: u.cooldowns,
    statuses: u.statuses,
    respawnIn: u.respawnIn,
  };
}

/** Rebuilds a Unit on the client. Other players' orders stay server-side, so they read as idle. */
export function fromUnitSnapshot(s: UnitSnapshot): Unit {
  const def = CHAMPIONS[s.champ];
  if (!def) throw new Error(`Unknown champion "${s.champ}"`);
  return {
    id: s.id,
    team: s.team,
    def,
    spawn: s.spawn,
    pos: s.pos,
    facing: s.facing,
    hp: s.hp,
    mana: s.mana,
    order: { kind: 'idle' },
    attackCooldown: s.attackCooldown,
    windup: s.windup,
    cast: s.cast,
    dash: s.dash,
    cooldowns: s.cooldowns,
    statuses: s.statuses,
    respawnIn: s.respawnIn,
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec =>
  typeof v === 'object' && v !== null && isNum((v as Vec).x) && isNum((v as Vec).y);
const isSlot = (v: unknown): v is AbilitySlot => ABILITY_SLOTS.includes(v as AbilitySlot);

/** Validates an untrusted client message. Returns a clean copy, or null if it is malformed. */
export function parsePlayerCommand(raw: unknown): PlayerCommand | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'move':
    case 'attackMove':
      return isVec(m.target) ? { type: m.type, target: { x: m.target.x, y: m.target.y } } : null;
    case 'attack':
      return isNum(m.targetId) ? { type: 'attack', targetId: m.targetId } : null;
    case 'cast':
      return isSlot(m.slot) && isVec(m.target)
        ? { type: 'cast', slot: m.slot, target: { x: m.target.x, y: m.target.y } }
        : null;
    case 'stop':
      return { type: 'stop' };
    default:
      return null;
  }
}

/** Validates an untrusted command message. A bad `cmd` is dropped but its seq is still acknowledged. */
export function parseCommandMessage(raw: unknown): { seq: number; cmd: PlayerCommand | null } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { seq, cmd } = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return null;
  return { seq: seq as number, cmd: cmd === undefined ? null : parsePlayerCommand(cmd) };
}
