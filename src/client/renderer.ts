import { Container, Graphics, Text } from 'pixi.js';
import { FOUNTAINS, FOUNTAIN_RADIUS, LANE_Y, MISSILE_HEIGHT, TURRET_POSITIONS, WORLD_SIZE } from '../sim/defs';
import { add, angleOf, dist, fromAngle, normalize, scale, sub, type Vec } from '../sim/math';
import {
  isChampion,
  isMinion,
  isStructure,
  isUntargetable,
  type GameView,
  type Projectile,
  type Shadow,
  type SimEvent,
  type Team,
  type Unit,
} from '../sim/world';
import type { Camera } from './camera';
import type { Controls, MarkerKind } from './controls';
import { COLORS, FONT, bodyHeight, bodyRadius, hpColor, teamColor, teamLight } from './theme';

/** Turret shots fly this much higher than other missiles, from the crystal at the top of the tower. */
const TURRET_SHOT_LIFT = 270;
/** Combat text starts this high above a unit's feet. */
const FLOAT_HEIGHT = 220;
const MARKER_SECONDS = 0.45;
const SPARK_SECONDS = 0.3;
const FLOAT_SECONDS = 0.9;
const BLINK_TRAIL_SECONDS = 0.35;
const MARK_COLOR = 0xc77dff;
const SHADOW_COLOR = 0x2a1740;
const DEATH_MARK_COLOR = 0xff2e4d;
const SLOW_COLOR = 0x7fd3ff;
const SLASH_SECONDS = 0.3;
const ULT_COLOR = 0xffd166;
/** Enemy turret range shows up when you come this close to it. */
const TURRET_RING_NOTICE = 450;

interface ClickMarker {
  pos: Vec;
  color: number;
  age: number;
}

interface Spark {
  pos: Vec;
  color: number;
  age: number;
}

interface SlashRing {
  pos: Vec;
  radius: number;
  color: number;
  age: number;
}

interface BlinkTrail {
  from: Vec;
  to: Vec;
  color: number;
  age: number;
}

interface FloatingText {
  text: Text;
  pos: Vec;
  drift: number;
  age: number;
}

/** Where to draw things this frame: offline these interpolate between ticks, online between snapshots. */
export type RenderPos = (u: Unit) => Vec;
export type ProjectilePos = (p: Projectile) => Vec;
export type ShadowPos = (s: Shadow) => Vec;

export class Renderer {
  /** World-space layer, turned and squashed by the camera: floor, rings, indicators. */
  private readonly groundView = new Container();
  private readonly ground = new Container();
  private readonly groundFx = new Graphics();
  /** Screen-space, upright units and missiles, depth-sorted by where they stand on screen. */
  private readonly unitLayer = new Container();
  private readonly missileViews = new Map<number, Graphics>();
  private readonly air = new Graphics();
  private readonly texts = new Container();
  private readonly views = new Map<number, View>();
  private markers: ClickMarker[] = [];
  private sparks: Spark[] = [];
  private blinks: BlinkTrail[] = [];
  private slashes: SlashRing[] = [];
  private readonly shadowViews = new Map<number, ShadowView>();
  private floats: FloatingText[] = [];

  constructor(
    stage: Container,
    private readonly world: GameView,
    private readonly camera: Camera,
    private readonly controls: Controls,
    private readonly playerId: number,
  ) {
    this.ground.addChild(drawMap(), this.groundFx);
    this.unitLayer.sortableChildren = true;
    this.groundView.addChild(this.ground);
    stage.addChild(this.groundView, this.unitLayer, this.air, this.texts);
  }

  addMarker(pos: Vec, kind: MarkerKind): void {
    this.markers.push({ pos: { ...pos }, color: kind === 'move' ? COLORS.moveMarker : COLORS.attackMarker, age: 0 });
  }

  handleEvent(ev: SimEvent): void {
    switch (ev.type) {
      case 'damage': {
        const view = this.views.get(ev.targetId);
        if (view) {
          view.flash = 1;
          view.pop = 1;
        }
        // Like LoL, only show numbers for damage you deal or take; the minion war stays quiet.
        if (ev.sourceId !== this.playerId && ev.targetId !== this.playerId) {
          this.sparks.push({ pos: { ...ev.pos }, color: COLORS.muted, age: SPARK_SECONDS * 0.4 });
          break;
        }
        const color = ev.detonation
          ? MARK_COLOR
          : ev.source !== 'attack'
            ? 0x8fd0ff
            : ev.targetId === this.playerId
              ? 0xff6b6b
              : COLORS.text;
        this.sparks.push({ pos: { ...ev.pos }, color, age: 0 });
        this.float(String(Math.round(ev.amount)), ev.pos, color, ev.detonation ? 32 : ev.source !== 'attack' ? 28 : 24);
        break;
      }
      case 'marked': {
        const u = this.world.units.get(ev.unitId);
        if (u) this.float('marked', u.pos, MARK_COLOR, 16);
        break;
      }
      case 'blink': {
        const u = this.world.units.get(ev.unitId);
        const color = u ? teamLight(u.team) : COLORS.text;
        this.blinks.push({ from: ev.from, to: ev.to, color, age: 0 });
        this.sparks.push({ pos: ev.from, color, age: 0 }, { pos: ev.to, color, age: 0 });
        break;
      }
      case 'swap': {
        this.blinks.push({ from: ev.from, to: ev.to, color: MARK_COLOR, age: 0 });
        this.sparks.push({ pos: ev.from, color: MARK_COLOR, age: 0 }, { pos: ev.to, color: MARK_COLOR, age: 0 });
        break;
      }
      case 'slash': {
        const u = this.world.units.get(ev.unitId);
        this.slashes.push({ pos: ev.pos, radius: ev.radius, color: u ? teamLight(u.team) : COLORS.text, age: 0 });
        break;
      }
      case 'levelUp': {
        const u = this.world.units.get(ev.unitId);
        if (!u) break;
        if (ev.unitId === this.playerId) this.float(`LEVEL ${ev.level}`, u.pos, COLORS.gold, 28);
        this.slashes.push({ pos: { ...u.pos }, radius: u.def.radius + 60, color: COLORS.gold, age: 0 });
        break;
      }
      case 'deathMarked': {
        const u = this.world.units.get(ev.unitId);
        if (u) this.float('MARKED', u.pos, DEATH_MARK_COLOR, 26);
        break;
      }
      case 'attackFired': {
        const view = this.views.get(ev.unitId);
        if (view) view.pop = Math.max(view.pop, 0.5);
        // Melee swings have no missile, so show the cut on the target.
        const attacker = this.world.units.get(ev.unitId);
        const target = this.world.units.get(ev.targetId);
        if (attacker && target && attacker.def.attackProjectileSpeed <= 0) {
          this.sparks.push({ pos: { ...target.pos }, color: teamLight(attacker.team), age: 0 });
        }
        break;
      }
      case 'castFired': {
        const view = this.views.get(ev.unitId);
        if (view) view.pop = Math.max(view.pop, 0.5);
        break;
      }
      case 'attackCanceled':
        if (ev.unitId === this.playerId) {
          const u = this.world.units.get(ev.unitId);
          if (u) this.float('cancel', u.pos, COLORS.muted, 16);
        }
        break;
      case 'skillshotExpired':
        this.sparks.push({ pos: ev.pos, color: COLORS.muted, age: 0 });
        break;
      case 'death':
        if (ev.kind === 'champion') this.float(ev.unitId === this.playerId ? 'SLAIN' : 'KILL', ev.pos, COLORS.gold, 40);
        else if (ev.kind === 'turret') this.float('TURRET DESTROYED', ev.pos, COLORS.gold, 34);
        if (ev.killerId === this.playerId && ev.kind !== 'champion') this.float(`+${ev.bounty}g`, ev.pos, COLORS.gold, 20);
        break;
      default:
        break;
    }
  }

  render(renderPos: RenderPos, projectilePos: ProjectilePos, shadowPos: ShadowPos, dt: number): void {
    this.camera.applyTo(this.groundView, this.ground);
    this.drawGroundFx(renderPos, projectilePos, shadowPos, dt);
    this.drawUnits(renderPos, dt);
    this.drawShadows(shadowPos);
    this.drawMissiles(projectilePos);
    this.drawAir(renderPos, dt);
    this.drawFloats(dt);
  }

  // --- floor: rings, range circles, aim lanes, click markers --------------

  private drawGroundFx(renderPos: RenderPos, projectilePos: ProjectilePos, shadowPos: ShadowPos, dt: number): void {
    const g = this.groundFx.clear();
    const player = this.world.units.get(this.playerId);
    const playerAlive = !!player && this.world.isAlive(player);

    // Enemy turret range, once you get close, brighter when it is shooting you.
    if (player && playerAlive) {
      const pp = renderPos(player);
      for (const t of this.world.units.values()) {
        if (!isStructure(t) || t.team === player.team || !this.world.isAlive(t)) continue;
        const reach = t.def.attackRange + t.def.radius + player.def.radius;
        const gap = dist(pp, t.pos) - reach;
        if (gap > TURRET_RING_NOTICE) continue;
        const onMe = t.order.kind === 'attack' && t.order.targetId === player.id;
        const alpha = onMe ? 0.9 : 0.25 + 0.45 * Math.min(1, 1 - gap / TURRET_RING_NOTICE);
        g.circle(t.pos.x, t.pos.y, reach).stroke({ width: onMe ? 6 : 4, color: COLORS.red, alpha });
      }
    }

    for (const u of this.world.units.values()) {
      if (!this.world.isAlive(u)) continue;
      const p = renderPos(u);
      const hovered = this.controls.hoverId === u.id;
      const ring = isChampion(u) || hovered;
      if (ring) g.circle(p.x, p.y, u.def.radius + 6).stroke({ width: hovered ? 6 : 3, color: teamColor(u.team), alpha: 0.9 });
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
      if (u.statuses.some((st) => st.kind === 'mark')) {
        g.circle(p.x, p.y, u.def.radius + 16 + pulse * 4).stroke({ width: 4, color: MARK_COLOR, alpha: 0.6 + 0.4 * pulse });
      }
      const deathMark = u.statuses.find((st) => st.kind === 'deathMark');
      if (deathMark) {
        // Tightens as the detonation approaches.
        const r = u.def.radius + 10 + deathMark.remaining * 18;
        g.circle(p.x, p.y, r).stroke({ width: 5, color: DEATH_MARK_COLOR, alpha: 0.6 + 0.4 * pulse });
      }
      if (u.statuses.some((st) => st.kind === 'slow')) {
        g.circle(p.x, p.y, u.def.radius + 2).fill({ color: SLOW_COLOR, alpha: 0.18 });
      }
    }

    // Each skillshot's shadow on the floor, as wide as it hits: where it really is, under the
    // missile flying at waist height. Dodge the shadow, not the glow.
    for (const p of this.world.projectiles) {
      if (p.kind !== 'skillshot') continue;
      const at = projectilePos(p);
      g.circle(at.x, at.y, p.width / 2).fill({ color: 0x000000, alpha: 0.22 });
    }

    if (player && playerAlive) {
      const pp = renderPos(player);
      if (this.controls.attackMoveArmed) {
        g.circle(pp.x, pp.y, player.def.attackRange + player.def.radius).stroke({ width: 3, color: 0xffffff, alpha: 0.45 });
      }
      const slot = this.controls.aiming;
      const myShadows = this.world.shadows.filter((sh) => sh.ownerId === player.id);
      const mimicking = slot && player.def.shadowMimics?.includes(slot) ? myShadows : [];
      const aimed = this.controls.aiming && player.def.abilities[this.controls.aiming];
      const mouse = this.controls.mouseWorld;
      const dir = normalize(sub(mouse, pp));
      const color = this.controls.aiming === 'R' ? ULT_COLOR : 0x5fb8ff;
      if (aimed?.kind === 'skillshot' && (dir.x !== 0 || dir.y !== 0)) {
        drawLane(g, pp, dir, aimed.range, aimed.width, color, 0.22, 0.9);
        for (const sh of mimicking) {
          const sp = shadowPos(sh);
          const d = normalize(sub(mouse, sp));
          if (d.x || d.y) drawLane(g, sp, d, aimed.range, aimed.width, MARK_COLOR, 0.14, 0.6);
        }
      } else if (aimed?.kind === 'area') {
        g.circle(pp.x, pp.y, aimed.radius).fill({ color, alpha: 0.12 }).stroke({ width: 3, color, alpha: 0.8 });
        for (const sh of mimicking) {
          const sp = shadowPos(sh);
          g.circle(sp.x, sp.y, aimed.radius).fill({ color: MARK_COLOR, alpha: 0.1 }).stroke({ width: 3, color: MARK_COLOR, alpha: 0.6 });
        }
      } else if (aimed && (aimed.kind === 'shadow' || aimed.kind === 'deathMark') && myShadows.some((sh) => sh.slot === slot && !sh.swapped)) {
        // Recast: show the swap.
        const sh = myShadows.find((x) => x.slot === slot && !x.swapped)!;
        const sp = shadowPos(sh);
        g.moveTo(pp.x, pp.y).lineTo(sp.x, sp.y).stroke({ width: 4, color: MARK_COLOR, alpha: 0.7 });
        g.circle(sp.x, sp.y, player.def.radius).stroke({ width: 3, color: MARK_COLOR, alpha: 0.9 });
      } else if (aimed?.kind === 'shadow') {
        const dest = add(pp, scale(dir, Math.min(aimed.range, dist(pp, mouse))));
        g.moveTo(pp.x, pp.y).lineTo(dest.x, dest.y).stroke({ width: 3, color: MARK_COLOR, alpha: 0.6 });
        g.circle(dest.x, dest.y, player.def.radius).fill({ color: SHADOW_COLOR, alpha: 0.35 }).stroke({ width: 3, color: MARK_COLOR, alpha: 0.9 });
      } else if (aimed?.kind === 'deathMark') {
        g.circle(pp.x, pp.y, aimed.range).stroke({ width: 3, color: DEATH_MARK_COLOR, alpha: 0.6 });
        const target = [...this.world.units.values()]
          .filter((u) => u.team !== player.team && this.world.isAlive(u) && dist(pp, u.pos) <= aimed.range + u.def.radius)
          .sort((a, b) => dist(mouse, a.pos) - dist(mouse, b.pos))[0];
        if (target && dist(mouse, target.pos) <= 250 + target.def.radius) {
          const tp = renderPos(target);
          g.circle(tp.x, tp.y, target.def.radius + 12).stroke({ width: 5, color: DEATH_MARK_COLOR, alpha: 0.9 });
        }
      } else if (aimed?.kind === 'blink') {
        const dest = add(pp, scale(dir, Math.min(aimed.range, dist(pp, mouse))));
        g.circle(pp.x, pp.y, aimed.range).stroke({ width: 3, color, alpha: 0.6 });
        g.circle(dest.x, dest.y, player.def.radius).fill({ color, alpha: 0.25 }).stroke({ width: 3, color, alpha: 0.9 });
        if (aimed.bolt) g.circle(dest.x, dest.y, aimed.bolt.range).stroke({ width: 2, color, alpha: 0.2 });
      }
    }

    this.slashes = this.slashes.filter((r) => (r.age += dt) < SLASH_SECONDS);
    for (const r of this.slashes) {
      const t = r.age / SLASH_SECONDS;
      g.circle(r.pos.x, r.pos.y, r.radius * (0.6 + 0.4 * t)).stroke({ width: 10 * (1 - t) + 2, color: r.color, alpha: 0.8 * (1 - t) });
    }

    this.blinks = this.blinks.filter((b) => (b.age += dt) < BLINK_TRAIL_SECONDS);
    for (const b of this.blinks) {
      const t = b.age / BLINK_TRAIL_SECONDS;
      g.moveTo(b.from.x, b.from.y).lineTo(b.to.x, b.to.y).stroke({ width: 18 * (1 - t), color: b.color, alpha: 0.5 * (1 - t), cap: 'round' });
    }

    this.markers = this.markers.filter((m) => (m.age += dt) < MARKER_SECONDS);
    for (const m of this.markers) {
      const t = m.age / MARKER_SECONDS;
      const r = 8 + 26 * (1 - t);
      g.circle(m.pos.x, m.pos.y, r).stroke({ width: 4, color: m.color, alpha: 1 - t });
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        const outer = add(m.pos, scale({ x: Math.cos(a), y: Math.sin(a) }, r + 14));
        const inner = add(m.pos, scale({ x: Math.cos(a), y: Math.sin(a) }, r + 4));
        g.moveTo(outer.x, outer.y).lineTo(inner.x, inner.y).stroke({ width: 4, color: m.color, alpha: 1 - t, cap: 'round' });
      }
    }
  }

  // --- units --------------------------------------------------------------

  private drawUnits(renderPos: RenderPos, dt: number): void {
    for (const [id, view] of this.views) {
      if (this.world.units.has(id)) continue;
      view.root.destroy({ children: true });
      this.views.delete(id);
    }
    for (const u of this.world.units.values()) {
      let view = this.views.get(u.id);
      if (!view) {
        const allied = u.team === (this.world.units.get(this.playerId)?.team ?? 'blue');
        view = isStructure(u) ? new TurretView(u, allied) : isMinion(u) ? new MinionView(u, allied) : new UnitView(u, u.id === this.playerId);
        this.views.set(u.id, view);
        this.unitLayer.addChild(view.root);
      }
      const p = renderPos(u);
      const s = this.camera.worldToScreen(p);
      view.root.position.set(s.x, s.y);
      view.root.zIndex = s.y;
      view.update(u, this.world.isAlive(u), this.camera, dt);
    }
  }

  private drawShadows(shadowPos: ShadowPos): void {
    const live = new Set(this.world.shadows.map((sh) => sh.id));
    for (const [id, view] of this.shadowViews) {
      if (live.has(id)) continue;
      view.root.destroy({ children: true });
      this.shadowViews.delete(id);
    }
    for (const sh of this.world.shadows) {
      const owner = this.world.units.get(sh.ownerId);
      if (!owner) continue;
      let view = this.shadowViews.get(sh.id);
      if (!view) {
        view = new ShadowView(owner);
        this.shadowViews.set(sh.id, view);
        this.unitLayer.addChild(view.root);
      }
      const p = shadowPos(sh);
      const s = this.camera.worldToScreen(p);
      view.root.position.set(s.x, s.y);
      view.root.zIndex = s.y;
      view.root.scale.set(this.camera.zoom);
      // Fade out over the last second.
      view.root.alpha = Math.min(1, sh.remaining) * (sh.swapped ? 0.55 : 0.8);
    }
  }

  // --- missiles: upright, sorted with the units, so one behind you passes behind you ---

  private drawMissiles(projectilePos: ProjectilePos): void {
    const live = new Set(this.world.projectiles.map((p) => p.id));
    for (const [id, g] of this.missileViews) {
      if (live.has(id)) continue;
      g.destroy();
      this.missileViews.delete(id);
    }
    const z = this.camera.zoom;
    const lift = MISSILE_HEIGHT * z;
    for (const p of this.world.projectiles) {
      let g = this.missileViews.get(p.id);
      if (!g) {
        g = new Graphics();
        this.missileViews.set(p.id, g);
        this.unitLayer.addChild(g);
      }
      g.clear();
      const s = this.camera.worldToScreen(projectilePos(p));
      g.zIndex = s.y;
      s.y -= lift;
      this.drawMissile(g, p, s, z);
    }
  }

  private drawMissile(g: Graphics, p: Projectile, s: Vec, z: number): void {
    const color = teamColor(p.team);
    const light = teamLight(p.team);
    const owner = this.world.units.get(p.ownerId);
    if (p.kind === 'homing' && owner && isStructure(owner)) {
      s.y -= TURRET_SHOT_LIFT * z;
      g.circle(s.x, s.y, 26 * z).fill({ color, alpha: 0.35 });
      g.circle(s.x, s.y, 13 * z).fill(0xffffff);
      return;
    }
    if (p.kind === 'homing' && owner && isMinion(owner)) {
      g.circle(s.x, s.y, (p.speed > 1000 ? 11 : 8) * z).fill({ color, alpha: 0.45 });
      g.circle(s.x, s.y, (p.speed > 1000 ? 6 : 4) * z).fill(light);
      return;
    }
    if (p.kind === 'homing') {
      // Auto-attacks are small; ability bolts (the blink's) glow brighter.
      const ability = p.source !== 'attack';
      g.circle(s.x, s.y, (ability ? 20 : 13) * z).fill({ color: ability ? 0x9be7ff : color, alpha: 0.35 });
      g.circle(s.x, s.y, (ability ? 9 : 7) * z).fill(ability ? 0xffffff : light);
      return;
    }
    const d = this.camera.dirToScreen(p.dir);
    if (p.slot === 'W') {
      // A slow, fat orb.
      g.circle(s.x, s.y, p.width * 0.35 * z).fill({ color: MARK_COLOR, alpha: 0.3 });
      g.circle(s.x, s.y, p.width * 0.18 * z).fill({ color: 0xe9c6ff, alpha: 0.95 });
    } else if (p.slot === 'R') {
      // A wide golden barrage.
      const tail = sub(s, scale(d, 220 * z));
      g.moveTo(tail.x, tail.y).lineTo(s.x, s.y).stroke({ width: p.width * 0.7 * z, color: ULT_COLOR, alpha: 0.25, cap: 'round' });
      g.moveTo(tail.x, tail.y).lineTo(s.x, s.y).stroke({ width: p.width * 0.25 * z, color: 0xfff3c4, alpha: 0.9, cap: 'round' });
    } else {
      const tail = sub(s, scale(d, 90 * z));
      const core = sub(s, scale(d, 45 * z));
      g.moveTo(tail.x, tail.y).lineTo(s.x, s.y).stroke({ width: p.width * 0.4 * z, color, alpha: 0.3, cap: 'round' });
      g.moveTo(core.x, core.y).lineTo(s.x, s.y).stroke({ width: 10 * z, color: 0xffffff, cap: 'round' });
      g.circle(s.x, s.y, 11 * z).fill(light);
    }
  }

  // --- turret beams and hit sparks (screen space, above everything) ---------

  private drawAir(renderPos: RenderPos, dt: number): void {
    const g = this.air.clear();
    const z = this.camera.zoom;
    const lift = MISSILE_HEIGHT * z;

    // Turret aggro: a beam from the crystal to whatever it is shooting, red when it's you.
    for (const t of this.world.units.values()) {
      if (!isStructure(t) || t.order.kind !== 'attack' || !this.world.isAlive(t)) continue;
      const target = this.world.units.get(t.order.targetId);
      if (!target || !this.world.isAlive(target)) continue;
      const from = this.camera.worldToScreen(t.pos);
      from.y -= bodyRadius(t.def) * bodyHeight(t.def) * z;
      const to = this.camera.worldToScreen(renderPos(target));
      to.y -= bodyRadius(target.def) * z;
      const onMe = target.id === this.playerId;
      g.moveTo(from.x, from.y)
        .lineTo(to.x, to.y)
        .stroke({ width: (onMe ? 4 : 2) * z, color: onMe ? COLORS.red : teamLight(t.team), alpha: onMe ? 0.85 : 0.35 });
    }

    this.sparks = this.sparks.filter((sp) => (sp.age += dt) < SPARK_SECONDS);
    for (const sp of this.sparks) {
      const t = sp.age / SPARK_SECONDS;
      const s = this.camera.worldToScreen(sp.pos);
      g.circle(s.x, s.y - lift, (12 + 34 * t) * z).stroke({ width: 4 * (1 - t) + 1, color: sp.color, alpha: 1 - t });
    }
  }

  // --- floating combat text -------------------------------------------------

  private float(text: string, pos: Vec, color: number, size: number): void {
    const t = new Text({
      text,
      style: { fontFamily: FONT, fontSize: size, fontWeight: 'bold', fill: color, stroke: { color: 0x000000, width: 4 } },
    });
    t.anchor.set(0.5);
    this.texts.addChild(t);
    this.floats.push({ text: t, pos: { ...pos }, drift: (Math.random() - 0.5) * 40, age: 0 });
  }

  private drawFloats(dt: number): void {
    const z = this.camera.zoom;
    this.floats = this.floats.filter((f) => {
      f.age += dt;
      const t = f.age / FLOAT_SECONDS;
      if (t >= 1) {
        f.text.destroy();
        return false;
      }
      const s = this.camera.worldToScreen(f.pos);
      f.text.position.set(s.x + f.drift * t, s.y - FLOAT_HEIGHT * z - 50 * t);
      f.text.alpha = 1 - t * t;
      f.text.scale.set(t < 0.1 ? 1 + (0.1 - t) * 4 : 1);
      return true;
    });
  }
}

/** A filled lane on the floor with an arrowhead, used for skillshot aim and enemy telegraphs. */
function drawLane(g: Graphics, origin: Vec, dir: Vec, length: number, width: number, color: number, fill: number, edge: number): void {
  const hw = width / 2;
  const perp = { x: -dir.y, y: dir.x };
  const headLen = hw * 1.6;
  const bodyEnd = add(origin, scale(dir, length - headLen));
  const tip = add(origin, scale(dir, length));
  const corner = (base: Vec, side: number, w: number) => add(base, scale(perp, side * w));
  const pts = [
    corner(origin, 1, hw),
    corner(bodyEnd, 1, hw),
    corner(bodyEnd, 1, hw * 1.7),
    tip,
    corner(bodyEnd, -1, hw * 1.7),
    corner(bodyEnd, -1, hw),
    corner(origin, -1, hw),
  ];
  g.poly(pts.flatMap((p) => [p.x, p.y]))
    .fill({ color, alpha: fill })
    .stroke({ width: 3, color, alpha: edge });
}

/** Small deterministic noise, so the scenery looks scattered but never changes. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** The mid lane: grass between jungle walls, a dirt path, the river across the middle, bases and turret platforms. */
function drawMap(): Graphics {
  const { width: W, height: H } = WORLD_SIZE;
  const g = new Graphics();
  g.rect(-3000, -3000, W + 6000, H + 6000).fill(0x0a140e);

  const tile = 250;
  for (let x = 0; x < W; x += tile) {
    for (let y = 0; y < H; y += tile) {
      g.rect(x, y, tile, tile).fill((x / tile + y / tile) % 2 ? 0x2d5a37 : 0x305e3a);
    }
  }
  // The worn path minions walk.
  g.roundRect(0, LANE_Y - 330, W, 660, 300).fill({ color: 0x8a7350, alpha: 0.28 });
  g.roundRect(0, LANE_Y - 200, W, 400, 200).fill({ color: 0x9b8258, alpha: 0.18 });
  // The river crossing mid.
  g.poly([W * 0.46, -200, W * 0.52, -200, W * 0.54, H + 200, W * 0.48, H + 200]).fill({ color: 0x2b6a80, alpha: 0.55 });

  // Jungle walls along both sides and behind the bases, with trees on top.
  const wall = 0x1c2a20;
  g.rect(-3000, -3000, W + 6000, 3000).fill(wall);
  g.rect(-3000, H, W + 6000, 3000).fill(wall);
  g.rect(-3000, 0, 3000, H).fill(wall);
  g.rect(W, 0, 3000, H).fill(wall);
  g.rect(0, 0, W, H).stroke({ width: 18, color: 0x0f1912 });
  for (let i = 0; i < 160; i++) {
    const top = i % 2 === 0;
    const x = -600 + hash(i) * (W + 1200);
    const y = top ? -40 - hash(i + 0.5) * 520 : H + 40 + hash(i + 0.5) * 520;
    const r = 70 + hash(i + 0.25) * 90;
    g.circle(x, y, r).fill({ color: hash(i + 0.75) > 0.5 ? 0x173a22 : 0x1e4529, alpha: 0.95 });
  }

  // Bases and fountains.
  for (const team of ['blue', 'red'] as Team[]) {
    const f = FOUNTAINS[team];
    g.circle(f.x, f.y, FOUNTAIN_RADIUS + 120).fill({ color: 0x4d5560, alpha: 0.55 });
    g.circle(f.x, f.y, FOUNTAIN_RADIUS).fill({ color: teamColor(team), alpha: 0.12 }).stroke({ width: 6, color: teamColor(team), alpha: 0.5 });
    g.circle(f.x, f.y, 110).fill({ color: teamLight(team), alpha: 0.35 }).stroke({ width: 5, color: teamLight(team), alpha: 0.8 });
    const t = TURRET_POSITIONS[team];
    g.circle(t.x, t.y, 150).fill({ color: 0x5b6168, alpha: 0.7 }).stroke({ width: 5, color: 0x2a2f33, alpha: 0.8 });
  }
  return g;
}

/** What the renderer needs from a unit's on-screen figure. */
interface View {
  readonly root: Container;
  pop: number;
  flash: number;
  update(unit: Unit, alive: boolean, camera: Camera, dt: number): void;
}

class UnitView implements View {
  readonly root = new Container();
  pop = 0;
  flash = 0;
  private readonly body = new Graphics();
  private readonly flashBody = new Graphics();
  private readonly weapon = new Graphics();
  /** Health bar and name: they stay the same size on screen at any zoom, like LoL's. */
  private readonly overlay = new Container();
  private readonly bars = new Graphics();
  private readonly level: Text;
  private readonly status: Text;

  constructor(unit: Unit, private readonly isPlayer: boolean) {
    const r = bodyRadius(unit.def);
    const shadow = new Graphics().ellipse(0, 0, r * 1.05, r * 0.5).fill({ color: 0x000000, alpha: 0.35 });
    drawBody(this.body, r, teamColor(unit.team), teamLight(unit.team));
    drawBody(this.flashBody, r, 0xffffff, 0xffffff);
    this.flashBody.alpha = 0;
    const name = new Text({
      text: isPlayer ? 'You' : 'Enemy',
      style: { fontFamily: FONT, fontSize: 14, fontWeight: 'bold', fill: COLORS.text, stroke: { color: 0x000000, width: 3 } },
    });
    name.anchor.set(0.5, 1);
    name.position.set(0, -BAR_GAP_PX - 20);
    this.status = new Text({
      text: '',
      style: { fontFamily: FONT, fontSize: 20, fontWeight: 'bold', fill: COLORS.text, stroke: { color: 0x000000, width: 4 } },
    });
    this.status.anchor.set(0.5);
    this.status.position.set(0, -r * 1.2);
    this.overlay.position.set(0, -r * 2.7);
    this.level = new Text({
      text: '',
      style: { fontFamily: FONT, fontSize: 12, fontWeight: 'bold', fill: COLORS.gold },
    });
    this.level.anchor.set(0.5);
    this.overlay.addChild(this.bars, name, this.level);
    this.root.addChild(shadow, this.body, this.flashBody, this.weapon, this.overlay, this.status);
  }

  update(unit: Unit, alive: boolean, camera: Camera, dt: number): void {
    const zoom = camera.zoom;
    const r = bodyRadius(unit.def);
    this.pop = Math.max(0, this.pop - dt * 6);
    this.flash = Math.max(0, this.flash - dt * 8);
    this.root.scale.set(zoom * (1 + this.pop * 0.1));
    keepScreenSize(this.overlay, this.root);
    keepScreenSize(this.status, this.root);
    this.root.alpha = !alive ? 0.3 : isUntargetable(unit) ? 0.35 : 1;
    this.flashBody.alpha = this.flash * 0.8;
    this.status.text = alive ? '' : unit.respawnIn.toFixed(1);

    // Facing, drawn as a bow arm. It pulls back during the windup and snaps forward on release.
    const w = this.weapon.clear();
    const facing = angleOf(camera.dirToScreen(fromAngle(unit.facing)));
    const dir = { x: Math.cos(facing), y: Math.sin(facing) };
    const hand = { x: 0, y: -r * 1.25 };
    let reach = r * 1.4;
    let color = teamLight(unit.team);
    if (unit.windup) {
      const k = 1 - unit.windup.remaining / unit.windup.total;
      reach = r * (1.4 - 0.7 * k);
      color = COLORS.windup;
    }
    const end = add(hand, scale(dir, reach));
    w.moveTo(hand.x, hand.y).lineTo(end.x, end.y).stroke({ width: r * 0.18, color, cap: 'round' });
    if (unit.cast) {
      const k = 1 - unit.cast.remaining / unit.cast.total;
      const orb = add(hand, scale(dir, r * 0.9));
      w.circle(orb.x, orb.y, r * (0.15 + 0.3 * k)).fill({ color: teamLight(unit.team), alpha: 0.5 + 0.5 * k });
    }

    const b = this.bars.clear();
    this.level.visible = alive;
    if (!alive) return;
    const bw = 90;
    const bh = 10;
    const by = -BAR_GAP_PX - bh - 4;
    b.roundRect(-bw / 2 - 2, by - 2, bw + 4, bh + 8, 3).fill({ color: 0x0b0b0b, alpha: 0.85 });
    const { maxHp, maxMana } = unit.stats;
    b.rect(-bw / 2, by, (bw * unit.hp) / maxHp, bh).fill(hpColor(false, this.isPlayer));
    for (let hp = 100; hp < maxHp; hp += 100) {
      b.rect(-bw / 2 + (bw * hp) / maxHp, by, 1, bh).fill({ color: 0x000000, alpha: 0.5 });
    }
    if (maxMana > 0) b.rect(-bw / 2, by + bh + 1, (bw * unit.mana) / maxMana, 3).fill(unit.def.resource === 'energy' ? COLORS.energy : COLORS.mana);
    // Level, in a box at the left end of the bar, like LoL.
    b.roundRect(-bw / 2 - 24, by - 3, 20, bh + 8, 3).fill({ color: 0x0b0b0b, alpha: 0.9 }).stroke({ width: 1, color: COLORS.gold, alpha: 0.8 });
    this.level.text = String(unit.level);
    this.level.position.set(-bw / 2 - 14, by + bh / 2 + 1);
    // Passive attack-speed stacks as pips above the health bar.
    const stacks = unit.statuses.find((st) => st.kind === 'attackSpeed');
    if (stacks?.kind === 'attackSpeed') {
      for (let i = 0; i < stacks.stacks; i++) b.circle(-bw / 2 + 5 + i * 11, by - 7, 4).fill(COLORS.gold);
    }
  }
}

/** Gap in screen pixels between a unit's head and its health bar. */
const BAR_GAP_PX = 6;

/** Undoes the parent's zoom (and mirroring) so a health bar or label keeps its pixel size. */
function keepScreenSize(child: Container, parent: Container): void {
  child.scale.set(1 / parent.scale.x, 1 / parent.scale.y);
}

function drawBody(g: Graphics, r: number, main: number, light: number): void {
  g.roundRect(-r * 0.62, -r * 2, r * 1.24, r * 2, r * 0.55)
    .fill(main)
    .stroke({ width: 3, color: 0x0a0a0a, alpha: 0.6 });
  g.circle(0, -r * 2.15, r * 0.5)
    .fill(light)
    .stroke({ width: 3, color: 0x0a0a0a, alpha: 0.6 });
}

/** A champion's shadow: its silhouette in dark violet. */
class ShadowView {
  readonly root = new Container();

  constructor(owner: Unit) {
    const r = bodyRadius(owner.def);
    const shadow = new Graphics().ellipse(0, 0, r * 1.05, r * 0.5).fill({ color: 0x000000, alpha: 0.25 });
    const body = new Graphics();
    drawBody(body, r, SHADOW_COLOR, 0x4a2a6e);
    const eyes = new Graphics()
      .circle(-r * 0.18, -r * 2.2, r * 0.09)
      .circle(r * 0.18, -r * 2.2, r * 0.09)
      .fill(DEATH_MARK_COLOR);
    this.root.addChild(shadow, body, eyes);
  }
}

/** A lane minion: small, with a shape per type (blade, orb or cannon cart), and a thin health bar. */
class MinionView implements View {
  readonly root = new Container();
  pop = 0;
  flash = 0;
  private readonly body = new Graphics();
  private readonly flashBody = new Graphics();
  private readonly bars = new Graphics();

  constructor(unit: Unit, private readonly allied: boolean) {
    const r = bodyRadius(unit.def);
    const shadow = new Graphics().ellipse(0, 0, r * 1.1, r * 0.5).fill({ color: 0x000000, alpha: 0.3 });
    this.draw(this.body, unit, teamColor(unit.team), teamLight(unit.team));
    this.draw(this.flashBody, unit, 0xffffff, 0xffffff);
    this.flashBody.alpha = 0;
    this.bars.position.set(0, unit.def.id === 'minion-siege' ? -r * 1.7 : -r * 2.4);
    this.root.addChild(shadow, this.body, this.flashBody, this.bars);
  }

  private draw(g: Graphics, unit: Unit, main: number, light: number): void {
    const r = bodyRadius(unit.def);
    const edge = { width: 2, color: 0x0a0a0a, alpha: 0.6 };
    if (unit.def.id === 'minion-siege') {
      g.roundRect(-r, -r * 0.9, r * 2, r * 0.9, r * 0.2).fill(main).stroke(edge);
      g.circle(-r * 0.6, -r * 0.05, r * 0.3).circle(r * 0.6, -r * 0.05, r * 0.3).fill(0x2a2a2a);
      g.roundRect(-r * 0.25, -r * 1.55, r * 1.2, r * 0.45, r * 0.15).fill(light).stroke(edge);
      return;
    }
    g.roundRect(-r * 0.6, -r * 1.7, r * 1.2, r * 1.7, r * 0.5).fill(main).stroke(edge);
    g.circle(0, -r * 1.85, r * 0.45).fill(light).stroke(edge);
    if (unit.def.id === 'minion-caster') g.circle(r * 0.85, -r * 1.5, r * 0.28).fill({ color: light, alpha: 0.9 });
    else g.moveTo(r * 0.6, -r * 0.6).lineTo(r * 1.15, -r * 1.6).stroke({ width: r * 0.12, color: 0xd9dde2, cap: 'round' });
  }

  update(unit: Unit, alive: boolean, camera: Camera, dt: number): void {
    const zoom = camera.zoom;
    this.pop = Math.max(0, this.pop - dt * 6);
    this.flash = Math.max(0, this.flash - dt * 8);
    // Face the way it walks or swings.
    const facesLeft = camera.dirToScreen(fromAngle(unit.facing)).x < 0;
    this.root.scale.set(zoom * (facesLeft ? -1 : 1) * (1 + this.pop * 0.08), zoom * (1 + this.pop * 0.08));
    keepScreenSize(this.bars, this.root);
    this.root.alpha = alive ? 1 : 0;
    this.flashBody.alpha = this.flash * 0.8;
    const b = this.bars.clear();
    const bw = unit.def.id === 'minion-siege' ? 54 : 42;
    const by = -BAR_GAP_PX - 5;
    b.rect(-bw / 2 - 1, by - 1, bw + 2, 7).fill({ color: 0x0b0b0b, alpha: 0.85 });
    b.rect(-bw / 2, by, (bw * unit.hp) / unit.stats.maxHp, 5).fill(hpColor(this.allied, false));
  }
}

/** A turret: stone pedestal, tower and a team-colored crystal that charges up before each shot. */
class TurretView implements View {
  readonly root = new Container();
  pop = 0;
  flash = 0;
  private readonly crystal = new Graphics();
  private readonly flashBody = new Graphics();
  private readonly bars = new Graphics();

  constructor(unit: Unit, private readonly allied: boolean) {
    const r = bodyRadius(unit.def);
    const shadow = new Graphics().ellipse(0, 0, r * 1.6, r * 0.7).fill({ color: 0x000000, alpha: 0.4 });
    const tower = new Graphics();
    const edge = { width: 3, color: 0x0a0a0a, alpha: 0.6 };
    tower.ellipse(0, -r * 0.2, r * 1.3, r * 0.55).fill(0x6c727a).stroke(edge);
    tower.poly([-r * 0.9, -r * 0.3, r * 0.9, -r * 0.3, r * 0.6, -r * 3.6, -r * 0.6, -r * 3.6]).fill(0x8a9098).stroke(edge);
    tower.rect(-r * 0.6, -r * 2.2, r * 1.2, r * 0.25).fill(teamColor(unit.team));
    tower.poly([-r * 0.85, -r * 3.6, r * 0.85, -r * 3.6, r * 0.55, -r * 4.0, -r * 0.55, -r * 4.0]).fill(0x5d636b).stroke(edge);
    this.flashBody.poly([-r * 0.9, -r * 0.3, r * 0.9, -r * 0.3, r * 0.6, -r * 3.6, -r * 0.6, -r * 3.6]).fill(0xffffff);
    this.flashBody.alpha = 0;
    this.bars.position.set(0, -r * (bodyHeight(unit.def) + 0.9));
    this.root.addChild(shadow, tower, this.flashBody, this.crystal, this.bars);
  }

  update(unit: Unit, alive: boolean, camera: Camera, dt: number): void {
    const zoom = camera.zoom;
    const r = bodyRadius(unit.def);
    this.pop = Math.max(0, this.pop - dt * 6);
    this.flash = Math.max(0, this.flash - dt * 8);
    this.root.scale.set(zoom);
    keepScreenSize(this.bars, this.root);
    this.root.alpha = alive ? 1 : 0;
    this.flashBody.alpha = this.flash * 0.35;

    const charge = unit.windup ? 1 - unit.windup.remaining / unit.windup.total : 0;
    const top = -r * bodyHeight(unit.def);
    const c = this.crystal.clear();
    c.circle(0, top, r * (0.75 + 0.5 * charge)).fill({ color: teamColor(unit.team), alpha: 0.25 + 0.4 * charge });
    c.poly([0, top - r * 0.7, r * 0.4, top, 0, top + r * 0.7, -r * 0.4, top]).fill(teamLight(unit.team)).stroke({ width: 2, color: 0xffffff, alpha: 0.8 });

    const b = this.bars.clear();
    const bw = 130;
    const by = -BAR_GAP_PX - 10;
    b.roundRect(-bw / 2 - 2, by - 2, bw + 4, 14, 3).fill({ color: 0x0b0b0b, alpha: 0.85 });
    const maxHp = unit.stats.maxHp;
    b.rect(-bw / 2, by, (bw * unit.hp) / maxHp, 10).fill(hpColor(this.allied, false));
    for (let hp = 1000; hp < maxHp; hp += 1000) b.rect(-bw / 2 + (bw * hp) / maxHp, by, 1, 10).fill({ color: 0x000000, alpha: 0.5 });
  }
}
