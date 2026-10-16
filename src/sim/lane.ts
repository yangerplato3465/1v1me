import {
  CASTER_MINION,
  FOUNTAINS,
  LANE_Y,
  MELEE_MINION,
  MINION_SPAWNS,
  OUTER_TURRET,
  SIEGE_MINION,
  TURRET_POSITIONS,
  WAVES,
  type ChampionDef,
} from './defs';
import { dist, type Vec } from './math';
import { isChampion, isMinion, isStructure, kindOf, type CallForHelp, type Team, type Unit, type World } from './world';

/** LoL minions and turrets re-check their targets about this often (between attack windups). */
const THINK_SECONDS = 0.25;
/** How far, center to the target's edge, a minion looks for something to attack (LoL: 500). */
export const MINION_ACQUISITION_RANGE = 500;
/** Minions answer a call for help from an allied champion up to this far away (LoL: 1000). */
const MINION_CALL_RADIUS = 1000;
/** A turret answers an allied champion this close to it being hurt by an enemy champion (LoL: 1400). */
const TURRET_CALL_RADIUS = 1400;
/** Marching minions aim this far ahead along the lane's center line. */
const LANE_LOOKAHEAD = 600;

const TEAMS: Team[] = ['blue', 'red'];
const other = (team: Team): Team => (team === 'blue' ? 'red' : 'blue');

/**
 * LoL's minion targeting order (lower is more urgent), from the LoL wiki:
 * 1. an enemy champion attacking an allied champion
 * 2. an enemy minion attacking an allied champion
 * 3. an enemy minion attacking an allied minion
 * 4. an enemy turret attacking an allied minion
 * 5. the closest enemy minion
 * 6. the closest enemy champion
 * 7. the closest enemy turret
 * Since patch 26.10 a champion hitting minions no longer draws them.
 */
function minionCallPriority(victim: Unit, attacker: Unit): number | null {
  const v = kindOf(victim);
  const a = kindOf(attacker);
  if (v === 'champion' && a === 'champion') return 1;
  if (v === 'champion' && a === 'minion') return 2;
  if (v === 'minion' && a === 'minion') return 3;
  if (v === 'minion' && a === 'turret') return 4;
  return null;
}

const minionBasePriority = (target: Unit): number => (isMinion(target) ? 5 : isChampion(target) ? 6 : 7);

/** Turrets pick new targets by type: siege, then melee, then caster minions, then champions. */
function turretPriority(target: Unit): number {
  if (target.def.id === SIEGE_MINION.id) return 1;
  if (target.def.id === MELEE_MINION.id) return 2;
  if (isMinion(target)) return 3;
  return 4;
}

/** Seconds between waves at this game time. */
export function waveInterval(time: number): number {
  let interval = WAVES.interval[0][1];
  for (const [from, n] of WAVES.interval) if (time >= from) interval = n;
  return interval;
}

/**
 * Which minions a wave sends, in walking order, given the game time and how many waves
 * have passed since the last siege minion (counting this one).
 */
export function waveComposition(time: number, wavesSinceSiege: number): { units: ChampionDef[]; siege: boolean } {
  let every = WAVES.siegeEvery[0][1];
  for (const [from, n] of WAVES.siegeEvery) if (time >= from) every = n;
  const siege = wavesSinceSiege >= every;
  const melee = WAVES.melee - (siege && time >= WAVES.fewerMeleeWithSiegeFrom ? 1 : 0);
  const casters = WAVES.casters - (time >= WAVES.fewerCastersFrom ? 1 : 0);
  return {
    units: [...Array(melee).fill(MELEE_MINION), ...(siege ? [SIEGE_MINION] : []), ...Array(casters).fill(CASTER_MINION)],
    siege,
  };
}

/**
 * Runs the lane on an authoritative World: a turret per side, minion waves, and LoL's
 * targeting rules for both. Minions and turrets act only through normal attack and move
 * commands, like the practice bot.
 */
export class Lane {
  /** Seconds since the lane started (the game clock). */
  time = 0;
  /** Waves sent so far (per side). */
  waves = 0;
  private nextWaveAt = WAVES.firstAt;
  private wavesSinceSiege = 0;
  /** Minions still to walk out of each base, in order, one every WAVES.spawnSpacing. */
  private queue: { def: ChampionDef; at: number }[] = [];
  private thinkIn = 0;

  constructor(private readonly world: World) {
    world.fountains = { ...FOUNTAINS };
    for (const team of TEAMS) world.addUnit(OUTER_TURRET, team, TURRET_POSITIONS[team]);
  }

  update(dt: number): void {
    this.time += dt;
    while (this.time >= this.nextWaveAt) this.startWave();
    while (this.queue.length && this.time >= this.queue[0].at) {
      const { def } = this.queue.shift()!;
      for (const team of TEAMS) this.world.addUnit(def, team, MINION_SPAWNS[team]);
    }
    this.thinkIn -= dt;
    if (this.thinkIn > 0) return;
    this.thinkIn += THINK_SECONDS;
    for (const u of this.world.units.values()) {
      if (!this.world.isAlive(u) || u.windup) continue; // never change targets mid-windup
      if (isMinion(u)) this.thinkMinion(u);
      else if (isStructure(u)) this.thinkTurret(u);
    }
  }

  /** Queues a wave: both sides send the same minions, single file. */
  private startWave(): void {
    const start = this.nextWaveAt;
    this.waves++;
    this.wavesSinceSiege++;
    const { units, siege } = waveComposition(start, this.wavesSinceSiege);
    if (siege) this.wavesSinceSiege = 0;
    units.forEach((def, i) => this.queue.push({ def, at: start + i * WAVES.spawnSpacing }));
    this.nextWaveAt += waveInterval(start);
  }

  // --- minions -------------------------------------------------------------

  private thinkMinion(u: Unit): void {
    const current = u.order.kind === 'attack' ? this.world.units.get(u.order.targetId) : undefined;
    if (current && this.minionCanTarget(u, current)) {
      // LoL: calls for help are ignored while hitting a turret, and minions only switch to something more urgent.
      const best = this.minionPick(u, !isStructure(current));
      if (!best || best.priority >= this.minionPriority(u, current)) return;
      this.attack(u, best.target);
      return;
    }
    const best = this.minionPick(u, true);
    if (best) {
      this.attack(u, best.target);
      return;
    }
    // March on the enemy base along the middle of the lane, drifting back to it after a detour.
    const end = FOUNTAINS[other(u.team)].x;
    const ahead = Math.sign(end - u.pos.x);
    const goal: Vec = { x: Math.abs(end - u.pos.x) > LANE_LOOKAHEAD ? u.pos.x + ahead * LANE_LOOKAHEAD : end, y: LANE_Y };
    this.world.issue({ type: 'move', unitId: u.id, target: goal });
  }

  private minionCanTarget(u: Unit, target: Unit): boolean {
    if (target.team === u.team || !this.world.isTargetable(target)) return false;
    return dist(u.pos, target.pos) - target.def.radius <= MINION_ACQUISITION_RANGE;
  }

  /** Recent calls for help a minion answers: hits on its allies close by, by attackers it can reach. */
  private minionCalls(u: Unit): { call: CallForHelp; attacker: Unit; priority: number }[] {
    const out: { call: CallForHelp; attacker: Unit; priority: number }[] = [];
    for (const call of this.world.calls) {
      if (!call.drawsMinions) continue;
      const victim = this.world.units.get(call.victimId);
      const attacker = this.world.units.get(call.attackerId);
      if (!victim || !attacker || victim.team !== u.team || !this.minionCanTarget(u, attacker)) continue;
      if (dist(u.pos, victim.pos) > MINION_CALL_RADIUS) continue;
      const priority = minionCallPriority(victim, attacker);
      if (priority !== null) out.push({ call, attacker, priority });
    }
    return out;
  }

  /** How urgent this target is to the minion right now; a call's urgency wears off with the call. */
  private minionPriority(u: Unit, target: Unit): number {
    let priority = minionBasePriority(target);
    for (const c of this.minionCalls(u)) if (c.attacker.id === target.id) priority = Math.min(priority, c.priority);
    return priority;
  }

  private minionPick(u: Unit, answerCalls: boolean): { target: Unit; priority: number } | null {
    let best: { target: Unit; priority: number; d: number } | null = null;
    const consider = (target: Unit, priority: number) => {
      const d = dist(u.pos, target.pos);
      if (!best || priority < best.priority || (priority === best.priority && d < best.d)) best = { target, priority, d };
    };
    if (answerCalls) for (const c of this.minionCalls(u)) consider(c.attacker, c.priority);
    for (const target of this.world.units.values()) {
      if (this.minionCanTarget(u, target)) consider(target, minionBasePriority(target));
    }
    return best;
  }

  // --- turrets -------------------------------------------------------------

  /**
   * LoL turrets keep a target until it dies, leaves range or turns untargetable. If it isn't
   * already shooting a champion, an enemy champion hurting an allied champion within 1400
   * pulls it onto that champion. New targets go by type: siege, melee, caster, champion.
   */
  private thinkTurret(t: Unit): void {
    const current = t.order.kind === 'attack' ? this.world.units.get(t.order.targetId) : undefined;
    const keep = current && this.turretCanTarget(t, current);
    if (keep && isChampion(current)) return;
    const aggressor = this.turretCall(t);
    if (aggressor) {
      this.attack(t, aggressor);
      return;
    }
    if (keep) return;
    let best: { target: Unit; priority: number; d: number } | null = null;
    for (const target of this.world.units.values()) {
      if (!this.turretCanTarget(t, target)) continue;
      const priority = turretPriority(target);
      const d = dist(t.pos, target.pos);
      if (!best || priority < best.priority || (priority === best.priority && d < best.d)) best = { target, priority, d };
    }
    if (best) this.attack(t, (best as { target: Unit }).target);
    else if (t.order.kind !== 'idle') this.world.issue({ type: 'stop', unitId: t.id });
  }

  private turretCanTarget(t: Unit, target: Unit): boolean {
    return target.team !== t.team && !isStructure(target) && this.world.isTargetable(target) && this.world.inAttackRange(t, target);
  }

  /** The most recent enemy champion in range that hurt an allied champion near the turret. */
  private turretCall(t: Unit): Unit | null {
    for (let i = this.world.calls.length - 1; i >= 0; i--) {
      const call = this.world.calls[i];
      const victim = this.world.units.get(call.victimId);
      const attacker = this.world.units.get(call.attackerId);
      if (!victim || !attacker || !isChampion(victim) || !isChampion(attacker) || victim.team !== t.team) continue;
      if (dist(t.pos, victim.pos) > TURRET_CALL_RADIUS || !this.turretCanTarget(t, attacker)) continue;
      return attacker;
    }
    return null;
  }

  private attack(u: Unit, target: Unit): void {
    if (u.order.kind === 'attack' && u.order.targetId === target.id) return;
    this.world.issue({ type: 'attack', unitId: u.id, targetId: target.id });
  }
}
