import {
  CASTER_MINION,
  FOUNTAINS,
  MELEE_MINION,
  MINION_SPAWNS,
  OUTER_TURRET,
  SIEGE_MINION,
  TURRET_POSITIONS,
  WAVES,
  type ChampionDef,
} from './defs';
import { dist, type Vec } from './math';
import { isChampion, isMinion, isStructure, kindOf, type Team, type Unit, type World } from './world';

/** LoL minions and turrets re-check their targets about this often. */
const THINK_SECONDS = 0.25;
/** How far, center to the target's edge, a minion looks for something to attack. */
export const MINION_ACQUISITION_RANGE = 700;
/** A minion or turret answers a call for help from an ally this close to it. */
const CALL_RADIUS = 1000;
/** Priorities up to this one come from an allied champion, and may pull a minion or turret off its current target. */
const CHAMPION_CALL = 2;

const TEAMS: Team[] = ['blue', 'red'];
const other = (team: Team): Team => (team === 'blue' ? 'red' : 'blue');

/**
 * LoL's targeting order for minions and turrets (lower is more urgent):
 * 1. an enemy champion that hit an allied champion
 * 2. an enemy minion that hit an allied champion
 * 3. an enemy minion that hit an allied minion
 * 4. an enemy turret that hit an allied minion
 * 5. an enemy champion that hit an allied minion
 * 6. the closest enemy minion
 * 7. the closest enemy champion
 * 8. the closest enemy turret (minions only; turrets never target each other)
 */
function callPriority(victim: Unit, attacker: Unit): number | null {
  const v = kindOf(victim);
  const a = kindOf(attacker);
  if (v === 'champion' && a === 'champion') return 1;
  if (v === 'champion' && a === 'minion') return 2;
  if (v === 'minion' && a === 'minion') return 3;
  if (v === 'minion' && a === 'turret') return 4;
  if (v === 'minion' && a === 'champion') return 5;
  return null;
}

function closestPriority(target: Unit): number {
  return isMinion(target) ? 6 : isChampion(target) ? 7 : 8;
}

/** Siege minions per wave by game time, per WAVES.siegeEvery. */
export function hasSiegeMinion(wave: number, time: number): boolean {
  let every = WAVES.siegeEvery[0][1];
  for (const [from, n] of WAVES.siegeEvery) if (time >= from) every = n;
  return wave % every === 0;
}

/**
 * Runs the lane on an authoritative World: a turret per side, minion waves every 30 s,
 * and LoL's targeting rules for both. Minions and turrets act only through normal
 * attack and move commands, like the practice bot.
 */
export class Lane {
  /** Seconds since the lane started. */
  time = 0;
  /** Waves spawned so far (per side). */
  waves = 0;
  private thinkIn = 0;
  /** Unit id → priority of the target it is on, so only a more urgent champion call can pull it off. */
  private readonly onPriority = new Map<number, number>();

  constructor(private readonly world: World) {
    world.fountains = { ...FOUNTAINS };
    for (const team of TEAMS) world.addUnit(OUTER_TURRET, team, TURRET_POSITIONS[team]);
  }

  update(dt: number): void {
    this.time += dt;
    while (this.time >= WAVES.firstAt + this.waves * WAVES.interval) {
      this.waves++;
      for (const team of TEAMS) this.spawnWave(team, this.waves);
    }
    this.thinkIn -= dt;
    if (this.thinkIn > 0) return;
    this.thinkIn += THINK_SECONDS;
    for (const u of this.world.units.values()) {
      if (!isChampion(u) && this.world.isAlive(u)) this.think(u);
    }
    for (const id of this.onPriority.keys()) if (!this.world.units.has(id)) this.onPriority.delete(id);
  }

  /** Melee in front, then the siege minion, then casters, in rows of three. */
  private spawnWave(team: Team, wave: number): void {
    const front = MINION_SPAWNS[team];
    const back = team === 'blue' ? -1 : 1;
    const rows: ChampionDef[][] = [
      Array(WAVES.meleePerWave).fill(MELEE_MINION),
      hasSiegeMinion(wave, this.time) ? [SIEGE_MINION] : [],
      Array(WAVES.casterPerWave).fill(CASTER_MINION),
    ].filter((row) => row.length);
    rows.forEach((row, r) => {
      row.forEach((def, i) => {
        const y = front.y + (i - (row.length - 1) / 2) * 110;
        this.world.addUnit(def, team, { x: front.x + back * r * 130, y });
      });
    });
  }

  private think(u: Unit): void {
    const current = u.order.kind === 'attack' ? this.world.units.get(u.order.targetId) : undefined;
    const best = this.pick(u);
    if (current && this.canTarget(u, current)) {
      const priority = this.onPriority.get(u.id) ?? closestPriority(current);
      // Keep hitting the current target unless an allied champion calls for help with something more urgent.
      if (!best || best.target.id === current.id || best.priority > CHAMPION_CALL || best.priority >= priority) return;
    }
    if (best) {
      this.world.issue({ type: 'attack', unitId: u.id, targetId: best.target.id });
      this.onPriority.set(u.id, best.priority);
      return;
    }
    this.onPriority.delete(u.id);
    if (isMinion(u)) {
      // March on the enemy base, keeping the row it spawned in.
      const goal: Vec = { x: FOUNTAINS[other(u.team)].x, y: u.spawn.y };
      if (u.order.kind !== 'move' || u.order.target.x !== goal.x) this.world.issue({ type: 'move', unitId: u.id, target: goal });
    } else if (u.order.kind !== 'idle') {
      this.world.issue({ type: 'stop', unitId: u.id });
    }
  }

  /** Whether `u` may pick (or keep) this target: an enemy it can see, within its reach. */
  private canTarget(u: Unit, target: Unit): boolean {
    if (target.team === u.team || !this.world.isTargetable(target)) return false;
    if (isStructure(u)) return !isStructure(target) && this.world.inAttackRange(u, target);
    return dist(u.pos, target.pos) - target.def.radius <= MINION_ACQUISITION_RANGE;
  }

  private pick(u: Unit): { target: Unit; priority: number } | null {
    let best: { target: Unit; priority: number; d: number } | null = null;
    const consider = (target: Unit, priority: number) => {
      const d = dist(u.pos, target.pos);
      if (!best || priority < best.priority || (priority === best.priority && d < best.d)) best = { target, priority, d };
    };
    for (const call of this.world.calls) {
      const victim = this.world.units.get(call.victimId);
      const attacker = this.world.units.get(call.attackerId);
      if (!victim || !attacker || victim.team !== u.team || !this.canTarget(u, attacker)) continue;
      if (dist(u.pos, victim.pos) > CALL_RADIUS) continue;
      const priority = callPriority(victim, attacker);
      if (priority !== null) consider(attacker, priority);
    }
    for (const target of this.world.units.values()) {
      if (this.canTarget(u, target)) consider(target, closestPriority(target));
    }
    return best;
  }
}
