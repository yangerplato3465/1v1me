import { fromUnitSnapshot, type CommandMessage, type Snapshot } from '../net/protocol';
import { add, len, lerpVec, scale, sub, type Vec } from '../sim/math';
import { World, type PlayerCommand, type Shadow, type SimEvent, type Unit } from '../sim/world';

/** Corrections bigger than this (respawns, long desyncs) snap instead of blending. */
const SNAP_DISTANCE = 150;
/** How fast a blended correction fades, per second (~60 ms half-life). */
const CORRECTION_DECAY = 12;
/**
 * The offset is the max of this many recent samples. Samples jitter by a tick depending on
 * how client frames line up with server ticks; an average would keep rounding back and
 * forth between two values (one correction per flip), while the max stays put.
 */
const OFFSET_SAMPLES = 8;

interface Pending {
  seq: number;
  cmd: PlayerCommand | null;
  /** Local tick whose step first simulated this command. */
  sentTick: number;
}

/**
 * Client-side prediction for your own champion.
 *
 * Commands apply to a local copy of the World immediately. Each snapshot resets your
 * champion to the server's state and replays the commands the server hasn't seen yet, at
 * the same ticks they originally ran on, using a measured local→server tick offset. Any
 * remaining difference is blended out visually instead of snapping.
 *
 * Only your champion is predicted, including blinks. Other units sit at their snapshot
 * positions (for range checks), and missiles, damage and their side effects (cooldown
 * refunds, marks, passive stacks) arrive from the server.
 */
export class Predictor {
  /** Local steps simulated so far. */
  localTick = 0;
  /** Size of the most recent correction, in world units (for tests and debugging). */
  lastCorrection = 0;
  private world: World | null = null;
  private pending: Pending[] = [];
  private nextSeq = 0;
  /** Recent "server tick − local tick" at which commands landed. */
  private offsetSamples: number[] = [];
  private calibratedSeq = -1;
  private acc = 0;
  private prevPos: Vec | null = null;
  /** Events from forward-predicted steps (never from replays), for instant local feedback. */
  private events: SimEvent[] = [];
  private correction: Vec = { x: 0, y: 0 };
  private readonly step: number;

  constructor(
    private readonly playerId: number,
    tickRate: number,
  ) {
    this.step = 1 / tickRate;
  }

  /** Applies a command locally right away and returns the message to send to the server. */
  issue(cmd: PlayerCommand): CommandMessage {
    const seq = this.nextSeq++;
    this.pending.push({ seq, cmd, sentTick: this.localTick + 1 });
    this.world?.issue({ ...cmd, unitId: this.playerId });
    return { seq, cmd };
  }

  /** A command-less message the server only acknowledges, to measure the tick offset. */
  calibration(): CommandMessage {
    const seq = this.nextSeq++;
    this.pending.push({ seq, cmd: null, sentTick: this.localTick + 1 });
    return { seq };
  }

  /** Ticks the prediction runs ahead of the newest snapshot (≈ round trip), once measured. */
  get ticksAhead(): number | null {
    return this.offsetSamples.length ? Math.max(...this.offsetSamples) : null;
  }

  unit(): Unit | null {
    return this.world?.units.get(this.playerId) ?? null;
  }

  /** Your shadows as predicted, so a swap lands where you see the shadow. */
  shadows(): Shadow[] {
    return this.world?.shadows ?? [];
  }

  update(dt: number): void {
    const decay = Math.exp(-CORRECTION_DECAY * dt);
    this.correction = scale(this.correction, decay);
    if (!this.world) return;
    this.acc += dt;
    while (this.acc >= this.step) {
      const me = this.unit();
      this.prevPos = me ? { ...me.pos } : null;
      this.events.push(...this.advance(this.world));
      this.localTick++;
      this.acc -= this.step;
    }
  }

  /** Your own predicted events since the last call: fires, casts, blinks, canceled windups. */
  drainEvents(): SimEvent[] {
    const out = this.events.filter((e) => 'unitId' in e && e.unitId === this.playerId);
    this.events = [];
    return out;
  }

  renderPos(): Vec | null {
    const me = this.unit();
    if (!me) return null;
    const base = this.prevPos ? lerpVec(this.prevPos, me.pos, this.acc / this.step) : me.pos;
    return add(base, this.correction);
  }

  onSnapshot(s: Snapshot): void {
    const mine = s.units.find((u) => u.id === this.playerId);
    if (!mine || !s.you) return;
    // Start the local clock level with the first snapshot; the offset absorbs the rest.
    if (!this.world) this.localTick = s.tick;

    const acked = this.pending.find((p) => p.seq === s.you!.ack);
    if (acked && s.you.ack !== this.calibratedSeq) {
      this.offsetSamples.push(s.you.ackTick - acked.sentTick);
      if (this.offsetSamples.length > OFFSET_SAMPLES) this.offsetSamples.shift();
      this.calibratedSeq = s.you.ack;
    }
    this.pending = this.pending.filter((p) => p.seq > s.you!.ack);

    const before = this.unit()?.pos;
    const world = new World({ authoritative: false });
    for (const snap of s.units) {
      const unit = fromUnitSnapshot(structuredClone(snap));
      if (unit.id !== this.playerId) {
        // Other units are scenery here: they must not attack or cast at the prediction.
        unit.windup = null;
        unit.cast = null;
      }
      world.units.set(unit.id, unit);
    }
    world.units.get(this.playerId)!.order = structuredClone(s.you.order);
    // Your shadows matter for your movement (swaps); others' are just scenery for the renderer.
    world.shadows = structuredClone(s.shadows.filter((sh) => sh.ownerId === this.playerId));
    world.reserveIds(Math.max(0, ...s.units.map((u) => u.id), ...s.shadows.map((sh) => sh.id), ...s.projectiles.map((p) => p.id)));

    // Replay unacknowledged commands from the server's tick up to "now" in server ticks.
    const offset = this.ticksAhead ?? 0;
    const now = this.localTick + offset;
    let next = 0;
    for (let tick = s.tick + 1; tick <= now; tick++) {
      while (next < this.pending.length && this.pending[next].sentTick + offset <= tick) {
        this.apply(world, this.pending[next++]);
      }
      this.advance(world);
    }
    // Commands issued since the last local step take effect on the next one.
    while (next < this.pending.length) this.apply(world, this.pending[next++]);
    this.world = world;

    const after = world.units.get(this.playerId)!.pos;
    const delta = before ? sub(before, after) : { x: 0, y: 0 };
    this.lastCorrection = len(delta);
    if (this.lastCorrection > SNAP_DISTANCE) {
      this.correction = { x: 0, y: 0 };
      this.prevPos = { ...after };
    } else {
      this.correction = add(this.correction, delta);
      if (this.prevPos) this.prevPos = sub(this.prevPos, delta);
    }
  }

  private apply(world: World, p: Pending): void {
    if (p.cmd) world.issue({ ...p.cmd, unitId: this.playerId });
  }

  /** One predicted step. The world is non-authoritative, so it spawns no missiles and deals no damage. */
  private advance(world: World): SimEvent[] {
    world.step(this.step);
    return world.drainEvents();
  }
}
