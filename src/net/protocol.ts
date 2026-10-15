import { ABILITY_SLOTS, CHAMPIONS, type AbilitySlot } from '../sim/defs';
import type { Vec } from '../sim/math';
import type { PlayerCommand, Projectile, SimEvent, Team, Unit } from '../sim/world';

// Messages shared by the Colyseus server and the browser client. The server is
// authoritative: clients send PlayerCommands, the server sends a Snapshot every tick.

export const ROOM_NAME = 'duel';
/** 2567 is the Colyseus default, so pick a neighbour to coexist with other Colyseus projects. */
export const DEFAULT_PORT = 2568;

export const MSG = {
  /** client → server: a PlayerCommand */
  command: 'cmd',
  /** server → client: Welcome, once after joining */
  welcome: 'welcome',
  /** server → client: Snapshot, every tick */
  snapshot: 'snap',
} as const;

export interface JoinOptions {
  /** Solo room against the server-side practice bot. */
  practice?: boolean;
}

export interface Welcome {
  unitId: number;
  tickRate: number;
}

export interface UnitSnapshot {
  id: number;
  team: Team;
  champ: string;
  pos: Vec;
  facing: number;
  hp: number;
  mana: number;
  attackCooldown: number;
  windup: Unit['windup'];
  cast: Unit['cast'];
  cooldowns: Unit['cooldowns'];
  respawnIn: number;
}

export interface Snapshot {
  tick: number;
  units: UnitSnapshot[];
  projectiles: Projectile[];
  /** Events that happened during this tick. */
  events: SimEvent[];
}

export function toUnitSnapshot(u: Unit): UnitSnapshot {
  return {
    id: u.id,
    team: u.team,
    champ: u.def.id,
    pos: u.pos,
    facing: u.facing,
    hp: u.hp,
    mana: u.mana,
    attackCooldown: u.attackCooldown,
    windup: u.windup,
    cast: u.cast,
    cooldowns: u.cooldowns,
    respawnIn: u.respawnIn,
  };
}

/** Rebuilds a renderable Unit on the client. Orders stay server-side, so they read as idle. */
export function fromUnitSnapshot(s: UnitSnapshot): Unit {
  const def = CHAMPIONS[s.champ];
  if (!def) throw new Error(`Unknown champion "${s.champ}"`);
  return {
    id: s.id,
    team: s.team,
    def,
    spawn: s.pos,
    pos: s.pos,
    facing: s.facing,
    hp: s.hp,
    mana: s.mana,
    order: { kind: 'idle' },
    attackCooldown: s.attackCooldown,
    windup: s.windup,
    cast: s.cast,
    cooldowns: s.cooldowns,
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
