import { ABILITY_SLOTS, DEFAULT_SUMMONERS, SUMMONER_IDS, SUMMONER_SLOTS, UNIT_DEFS, type AbilitySlot, type SummonerId, type SummonerSlot } from '../sim/defs';
import type { Vec } from '../sim/math';
import { statsAt, type Order, type PlayerCommand, type Projectile, type Shadow, type SimEvent, type Team, type Unit } from '../sim/world';

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
  /** Summoner spells on D and F; invalid or duplicate picks fall back to the defaults. */
  summoners?: Record<SummonerSlot, SummonerId>;
  /**
   * Create a private room with a 4-digit code (its room id) that a friend joins with
   * `joinById(code)`. Matchmaking ("Find a duel") never puts anyone else in it.
   */
  privateRoom?: boolean;
}

/** Room codes are 4 digits, 1000-9999 (no leading zero to get lost). */
export const isRoomCode = (s: string): boolean => /^[1-9]\d{3}$/.test(s);

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
  postponed: Unit['postponed'];
  autoAttack: boolean;
  holdPosition: boolean;
}

export interface UnitSnapshot {
  id: number;
  team: Team;
  champ: string;
  level: number;
  xp: number;
  skillPoints: number;
  ranks: Unit['ranks'];
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
  summoners: Unit['summoners'];
  summonerCooldowns: Unit['summonerCooldowns'];
  /** What a minion or turret is attacking. Champions' orders stay private. */
  targetId?: number;
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
    level: u.level,
    xp: u.xp,
    skillPoints: u.skillPoints,
    ranks: u.ranks,
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
    summoners: u.summoners,
    summonerCooldowns: u.summonerCooldowns,
    ...(u.def.kind && u.def.kind !== 'champion' && u.order.kind === 'attack' ? { targetId: u.order.targetId } : {}),
  };
}

/** Rebuilds a Unit on the client. Other players' orders stay server-side, so they read as idle. */
export function fromUnitSnapshot(s: UnitSnapshot): Unit {
  const def = UNIT_DEFS[s.champ];
  if (!def) throw new Error(`Unknown unit "${s.champ}"`);
  return {
    id: s.id,
    team: s.team,
    def,
    level: s.level,
    xp: s.xp,
    skillPoints: s.skillPoints,
    ranks: s.ranks,
    stats: statsAt(def, s.level),
    spawn: s.spawn,
    pos: s.pos,
    facing: s.facing,
    hp: s.hp,
    mana: s.mana,
    order: s.targetId === undefined ? { kind: 'idle' } : { kind: 'attack', targetId: s.targetId },
    attackCooldown: s.attackCooldown,
    windup: s.windup,
    cast: s.cast,
    dash: s.dash,
    cooldowns: s.cooldowns,
    statuses: s.statuses,
    respawnIn: s.respawnIn,
    postponed: null,
    autoAttack: false,
    holdPosition: false,
    summoners: s.summoners,
    summonerCooldowns: s.summonerCooldowns,
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec =>
  typeof v === 'object' && v !== null && isNum((v as Vec).x) && isNum((v as Vec).y);
const isSlot = (v: unknown): v is AbilitySlot => ABILITY_SLOTS.includes(v as AbilitySlot);
const isSummonerSlot = (v: unknown): v is SummonerSlot => SUMMONER_SLOTS.includes(v as SummonerSlot);
const isSummoner = (v: unknown): v is SummonerId => SUMMONER_IDS.includes(v as SummonerId);

/** A valid pair of different summoner spells for D and F, or the defaults. */
export function parseSummoners(raw: unknown): Record<SummonerSlot, SummonerId> {
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return isSummoner(m.D) && isSummoner(m.F) && m.D !== m.F ? { D: m.D, F: m.F } : { ...DEFAULT_SUMMONERS };
}

/** Validates an untrusted client message. Returns a clean copy, or null if it is malformed. */
export function parsePlayerCommand(raw: unknown): PlayerCommand | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'move':
      return isVec(m.target) ? { type: 'move', target: { x: m.target.x, y: m.target.y } } : null;
    case 'attackMove':
      return isVec(m.target)
        ? { type: 'attackMove', target: { x: m.target.x, y: m.target.y }, onCursor: m.onCursor === true, championsOnly: m.championsOnly === true }
        : null;
    case 'autoAttack':
      return typeof m.enabled === 'boolean' ? { type: 'autoAttack', enabled: m.enabled } : null;
    case 'attack':
      return isNum(m.targetId) ? { type: 'attack', targetId: m.targetId } : null;
    case 'cast':
      return isSlot(m.slot) && isVec(m.target)
        ? { type: 'cast', slot: m.slot, target: { x: m.target.x, y: m.target.y } }
        : null;
    case 'levelUp':
      return isSlot(m.slot) ? { type: 'levelUp', slot: m.slot } : null;
    case 'summoner':
      return isSummonerSlot(m.slot) && isVec(m.target)
        ? { type: 'summoner', slot: m.slot, target: { x: m.target.x, y: m.target.y } }
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
