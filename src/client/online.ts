import { Client, type Room } from '@colyseus/sdk';
import type { SummonerId, SummonerSlot } from '../sim/defs';
import {
  DEFAULT_PORT,
  MSG,
  ROOM_NAME,
  fromUnitSnapshot,
  type JoinOptions,
  type Snapshot,
  type Welcome,
} from '../net/protocol';
import { clamp, dist, lerpVec, normalize, sub, type Vec } from '../sim/math';
import { isChampion, type GameView, type PlayerCommand, type Projectile, type Shadow, type SimEvent, type Unit } from '../sim/world';
import { CosmeticMissiles } from './cosmetic';
import { Predictor } from './prediction';
import type { Session } from './session';

/**
 * Render this many ticks behind the newest snapshot, so there is usually a later
 * snapshot to interpolate toward even when packets arrive unevenly (~66 ms at 30 Hz).
 */
const INTERP_DELAY_TICKS = 2;
/** Further off than this (in ticks) and the render clock jumps instead of easing. */
const RESYNC_TICKS = 4;
const MAX_FRAMES = 60;
const SNAP_DISTANCE = 200;
const WELCOME_TIMEOUT_MS = 5000;
/** Idle clients still ping this often so the prediction offset tracks latency changes. */
const CALIBRATE_SECONDS = 1;
/** Your own events that prediction shows instantly; the server's later copies are dropped. */
const PREDICTED_EVENTS = new Set<SimEvent['type']>([
  'attackStart',
  'attackFired',
  'attackCanceled',
  'castStart',
  'castFired',
  'blink',
  'swap',
  'slash',
]);

interface Frame {
  tick: number;
  units: Map<number, Vec>;
  projectiles: Map<number, Vec>;
  shadows: Map<number, Vec>;
}

class MirrorView implements GameView {
  units = new Map<number, Unit>();
  projectiles: Projectile[] = [];
  shadows: Shadow[] = [];

  isAlive(u: Unit): boolean {
    return u.respawnIn <= 0;
  }
}

export function defaultServerUrl(): string {
  return import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:${DEFAULT_PORT}`;
}

/** How to get into a room. */
export interface ConnectOptions {
  /**
   * duel: matchmaking with anyone; practice: alone with the server's bot; create: a private
   * room with a 4-digit code; join: the room with that `code`.
   */
  mode: 'duel' | 'practice' | 'create' | 'join';
  code?: string;
  /** Client-side prediction of your own champion (default on). */
  predict?: boolean;
  champ?: string;
  summoners?: Record<SummonerSlot, SummonerId>;
}

/**
 * Mirrors the authoritative server. Other units are drawn from interpolated snapshots
 * about 2 ticks in the past. Your own champion is predicted (see Predictor) so it
 * responds instantly, unless prediction is turned off for comparison.
 */
export class OnlineSession implements Session {
  readonly view = new MirrorView();
  playerId = -1;
  tickRate = 30;
  readonly note: string;
  private frames: Frame[] = [];
  private pending: { tick: number; event: SimEvent }[] = [];
  private latestTick = -1;
  private renderTick = -1;
  private from: Frame | null = null;
  private to: Frame | null = null;
  private alpha = 0;
  private disconnected = false;
  private predictor: Predictor | null = null;
  private readonly cosmetic = new CosmeticMissiles();
  private serverProjectiles: Projectile[] = [];
  private serverShadows: Shadow[] = [];
  private calibrateIn = 0;

  static async connect(endpoint: string, how: ConnectOptions = { mode: 'duel' }): Promise<OnlineSession> {
    const client = new Client(endpoint);
    const { mode, champ, summoners } = how;
    const options: JoinOptions = { champ, summoners };
    let room: Room;
    if (mode === 'practice') room = await client.create(ROOM_NAME, { ...options, practice: true });
    else if (mode === 'create') room = await client.create(ROOM_NAME, { ...options, privateRoom: true });
    else if (mode === 'join') room = await client.joinById(how.code ?? '', options);
    else room = await client.joinOrCreate(ROOM_NAME, options);
    const code = mode === 'create' || mode === 'join' ? room.roomId : null;
    const session = new OnlineSession(room, mode === 'practice', how.predict ?? true, code);
    await session.welcomed;
    return session;
  }

  private readonly welcomed: Promise<void>;

  private constructor(
    private readonly room: Room,
    private readonly practice: boolean,
    private readonly predict: boolean,
    /** The 4-digit code of a code room ("Create a room" / "Join"), or null. */
    readonly roomCode: string | null = null,
  ) {
    this.note = practice
      ? 'Online practice: the bot runs on the server.'
      : roomCode
        ? `Room ${roomCode}: a friend joins with this code from the start page.`
        : 'Online duel: open a second tab or browser to play against yourself.';
    // Register every handler before the first await so no early snapshot is dropped.
    room.onMessage(MSG.snapshot, (s: Snapshot) => this.onSnapshot(s));
    room.onLeave(() => (this.disconnected = true));
    this.welcomed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No welcome from server')), WELCOME_TIMEOUT_MS);
      room.onMessage(MSG.welcome, (w: Welcome) => {
        clearTimeout(timer);
        this.playerId = w.unitId;
        this.tickRate = w.tickRate;
        this.predictor = new Predictor(w.unitId, w.tickRate);
        resolve();
      });
    });
  }

  leave(): Promise<number> {
    return this.room.leave();
  }

  send(cmd: PlayerCommand): void {
    // Commands always go through the predictor: it numbers them, even with prediction off.
    if (this.predictor && !this.disconnected) this.room.send(MSG.command, this.predictor.issue(cmd));
  }

  update(dt: number): SimEvent[] {
    if (this.latestTick < 0) return [];

    // Advance the render clock, easing it toward "newest - delay" to absorb jitter.
    const target = this.latestTick - INTERP_DELAY_TICKS;
    this.renderTick += dt * this.tickRate;
    if (this.renderTick < 0 || Math.abs(this.renderTick - target) > RESYNC_TICKS) this.renderTick = target;
    else this.renderTick += (target - this.renderTick) * Math.min(1, dt * 2);
    this.renderTick = Math.min(this.renderTick, this.latestTick);

    while (this.frames.length >= 2 && this.frames[1].tick <= this.renderTick) this.frames.shift();
    this.from = this.frames[0] ?? null;
    this.to = this.frames[1] ?? this.from;
    this.alpha =
      this.from && this.to && this.to.tick > this.from.tick
        ? clamp((this.renderTick - this.from.tick) / (this.to.tick - this.from.tick), 0, 1)
        : 1;

    // Release events in step with what is drawn, so a hit number appears when the missile lands.
    const ready: SimEvent[] = [];
    while (this.pending.length && this.pending[0].tick <= this.renderTick) {
      const event = this.pending.shift()!.event;
      if (!(this.predict && this.isOwnPredicted(event))) ready.push(event);
    }

    if (this.predictor) {
      this.predictor.update(dt);
      this.calibrateIn -= dt;
      if (this.calibrateIn <= 0 && !this.disconnected) {
        this.room.send(MSG.command, this.predictor.calibration());
        this.calibrateIn = CALIBRATE_SECONDS;
      }
      this.showPrediction();
      const predicted = this.predictor.drainEvents();
      if (this.predict) {
        for (const event of predicted) this.spawnCosmetic(event);
        ready.push(...predicted);
      }
    }
    this.cosmetic.update(dt, this.view.units.values(), (u) => this.renderPos(u));
    this.showProjectiles();
    this.showShadows();
    return ready;
  }

  renderPos(u: Unit): Vec {
    if (this.predict && u.id === this.playerId) {
      const predicted = this.predictor?.renderPos();
      if (predicted) return predicted;
    }
    return this.interpolate(this.from?.units.get(u.id), this.to?.units.get(u.id)) ?? u.pos;
  }

  shadowPos(s: Shadow): Vec {
    if (this.predict && s.ownerId === this.playerId) return s.pos; // predicted, already current
    return this.interpolate(this.from?.shadows.get(s.id), this.to?.shadows.get(s.id)) ?? s.pos;
  }

  projectilePos(p: Projectile): Vec {
    if (p.id < 0) return p.pos; // cosmetic: already advanced per frame
    return this.interpolate(this.from?.projectiles.get(p.id), this.to?.projectiles.get(p.id)) ?? p.pos;
  }

  status(): string {
    if (this.disconnected) return 'disconnected from server';
    const mode = this.practice ? 'online practice' : 'online duel';
    const waiting = this.waitingForOpponent() ? ' · waiting for opponent…' : '';
    const ahead = this.predictor?.ticksAhead;
    const rtt = ahead === null || ahead === undefined ? '…' : `~${Math.round((ahead * 1000) / this.tickRate)} ms`;
    const prediction = this.predict ? 'prediction on' : 'prediction off';
    return `${mode} · room ${this.room.roomId}${waiting}\nround trip ${rtt} · ${prediction}`;
  }

  /** True until a second champion is in the match (never in practice: the bot is there). */
  private waitingForOpponent(): boolean {
    if (this.practice || this.disconnected) return false;
    return [...this.view.units.values()].filter(isChampion).length < 2;
  }

  banner(): string | null {
    if (!this.waitingForOpponent()) return null;
    return this.roomCode
      ? `Room code  ${this.roomCode}\nShare it with a friend: they pick "Join" on the start page and type it in.`
      : 'Waiting for an opponent…';
  }

  private interpolate(a: Vec | undefined, b: Vec | undefined): Vec | null {
    if (a && b) return dist(a, b) < SNAP_DISTANCE ? lerpVec(a, b, this.alpha) : b;
    return b ?? a ?? null;
  }

  private onSnapshot(s: Snapshot): void {
    if (s.tick <= this.latestTick) return;
    this.latestTick = s.tick;
    this.view.units = new Map(s.units.map((u) => [u.id, fromUnitSnapshot(u)]));
    this.serverProjectiles = s.projectiles;
    this.serverShadows = s.shadows;
    this.showProjectiles();
    this.frames.push({
      tick: s.tick,
      units: new Map(s.units.map((u) => [u.id, u.pos])),
      projectiles: new Map(s.projectiles.map((p) => [p.id, p.pos])),
      shadows: new Map(s.shadows.map((sh) => [sh.id, sh.pos])),
    });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
    for (const event of s.events) this.pending.push({ tick: s.tick, event });
    this.predictor?.onSnapshot(s);
    this.showPrediction();
    this.showShadows();
  }

  /** Others' shadows from snapshots; yours from the prediction, so swaps land where you see them. */
  private showShadows(): void {
    const own = this.predict && this.predictor ? this.predictor.shadows() : [];
    const others = this.serverShadows.filter((sh) => !(this.predict && sh.ownerId === this.playerId));
    this.view.shadows = [...others, ...own];
  }

  private isOwnPredicted(event: SimEvent): boolean {
    return PREDICTED_EVENTS.has(event.type) && 'unitId' in event && event.unitId === this.playerId;
  }

  /** Your released attacks and skillshots fly immediately as local, visual-only missiles. */
  private spawnCosmetic(event: SimEvent): void {
    const me = this.view.units.get(this.playerId);
    if (!me) return;
    if (event.type === 'attackFired' && me.def.attackProjectileSpeed > 0) {
      this.cosmetic.attack(me, event.targetId, this.renderPos(me));
    } else if (event.type === 'castFired') {
      const ability = me.def.abilities[event.slot];
      if (ability?.kind !== 'skillshot') return;
      this.cosmetic.skillshot(me, event.slot, ability, this.renderPos(me), event.dir);
      // Your shadows throw their copies at the same point.
      if (!me.def.shadowMimics?.includes(event.slot)) return;
      for (const sh of this.predictor?.shadows() ?? []) {
        const dir = normalize(sub(event.target, sh.pos));
        this.cosmetic.skillshot(me, event.slot, ability, sh.pos, dir.x || dir.y ? dir : event.dir, true);
      }
    }
  }

  /** Server missiles, minus the ones of yours already drawn as cosmetic copies. */
  private showProjectiles(): void {
    const hideOwn = (p: Projectile) =>
      this.predict && p.ownerId === this.playerId && (p.kind === 'skillshot' || p.source === 'attack');
    this.view.projectiles = [...this.serverProjectiles.filter((p) => !hideOwn(p)), ...this.cosmetic.list];
  }

  /** Swaps the predicted champion into the view, so the HUD shows instant cooldowns and windups too. */
  private showPrediction(): void {
    const predicted = this.predict ? this.predictor?.unit() : null;
    if (predicted) this.view.units.set(this.playerId, predicted);
  }
}
