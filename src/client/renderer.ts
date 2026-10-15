import { Container, Graphics, Text } from 'pixi.js';
import { WORLD_SIZE } from '../sim/defs';
import { add, angleOf, dist, normalize, scale, sub, type Vec } from '../sim/math';
import type { GameView, Projectile, SimEvent, Unit } from '../sim/world';
import { TILT, type Camera } from './camera';
import type { Controls, MarkerKind } from './controls';
import { COLORS, FONT, bodyRadius, teamColor, teamLight } from './theme';

/** How high above the floor missiles fly, in world units. */
const MISSILE_HEIGHT = 42;
const MARKER_SECONDS = 0.45;
const SPARK_SECONDS = 0.3;
const FLOAT_SECONDS = 0.9;
const BLINK_TRAIL_SECONDS = 0.35;
const MARK_COLOR = 0xc77dff;
const ULT_COLOR = 0xffd166;

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

export class Renderer {
  /** World-space layer squashed by the camera tilt: floor, rings, indicators. */
  private readonly ground = new Container();
  private readonly groundFx = new Graphics();
  /** Screen-space, upright units depth-sorted by world y. */
  private readonly unitLayer = new Container();
  private readonly air = new Graphics();
  private readonly texts = new Container();
  private readonly views = new Map<number, UnitView>();
  private markers: ClickMarker[] = [];
  private sparks: Spark[] = [];
  private blinks: BlinkTrail[] = [];
  private floats: FloatingText[] = [];

  constructor(
    stage: Container,
    private readonly world: GameView,
    private readonly camera: Camera,
    private readonly controls: Controls,
    private readonly playerId: number,
  ) {
    this.ground.addChild(drawArena(), this.groundFx);
    this.unitLayer.sortableChildren = true;
    stage.addChild(this.ground, this.unitLayer, this.air, this.texts);
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
      case 'attackFired':
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
      case 'death': {
        const u = this.world.units.get(ev.unitId);
        if (u) this.float(ev.unitId === this.playerId ? 'SLAIN' : 'KILL', u.pos, COLORS.gold, 40);
        break;
      }
      default:
        break;
    }
  }

  render(renderPos: RenderPos, projectilePos: ProjectilePos, dt: number): void {
    this.camera.applyTo(this.ground);
    this.drawGroundFx(renderPos, dt);
    this.drawUnits(renderPos, dt);
    this.drawAir(projectilePos, dt);
    this.drawFloats(dt);
  }

  // --- floor: rings, range circles, aim lanes, click markers --------------

  private drawGroundFx(renderPos: RenderPos, dt: number): void {
    const g = this.groundFx.clear();
    const player = this.world.units.get(this.playerId);
    const playerAlive = !!player && this.world.isAlive(player);

    for (const u of this.world.units.values()) {
      if (!this.world.isAlive(u)) continue;
      const p = renderPos(u);
      const hovered = this.controls.hoverId === u.id;
      g.circle(p.x, p.y, u.def.radius + 6).stroke({ width: hovered ? 6 : 3, color: teamColor(u.team), alpha: 0.9 });
      if (u.statuses.some((st) => st.kind === 'mark')) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
        g.circle(p.x, p.y, u.def.radius + 16 + pulse * 4).stroke({ width: 4, color: MARK_COLOR, alpha: 0.6 + 0.4 * pulse });
      }

      // Telegraph enemy casts so they can be read and dodged.
      const casting = u.cast && u.def.abilities[u.cast.slot];
      if (u.cast && casting?.kind === 'skillshot' && u.id !== this.playerId) {
        const k = 1 - u.cast.remaining / u.cast.total;
        drawLane(g, p, u.cast.dir, casting.range, casting.width, COLORS.red, 0.08 + 0.2 * k, 0.5);
      }
    }

    if (player && playerAlive) {
      const pp = renderPos(player);
      if (this.controls.attackMoveArmed) {
        g.circle(pp.x, pp.y, player.def.attackRange).stroke({ width: 3, color: 0xffffff, alpha: 0.45 });
      }
      const aimed = this.controls.aiming && player.def.abilities[this.controls.aiming];
      const mouse = this.controls.mouseWorld;
      const dir = normalize(sub(mouse, pp));
      const color = this.controls.aiming === 'R' ? ULT_COLOR : 0x5fb8ff;
      if (aimed?.kind === 'skillshot' && (dir.x !== 0 || dir.y !== 0)) {
        drawLane(g, pp, dir, aimed.range, aimed.width, color, 0.22, 0.9);
      } else if (aimed?.kind === 'blink') {
        const dest = add(pp, scale(dir, Math.min(aimed.range, dist(pp, mouse))));
        g.circle(pp.x, pp.y, aimed.range).stroke({ width: 3, color, alpha: 0.6 });
        g.circle(dest.x, dest.y, player.def.radius).fill({ color, alpha: 0.25 }).stroke({ width: 3, color, alpha: 0.9 });
        if (aimed.bolt) g.circle(dest.x, dest.y, aimed.bolt.range).stroke({ width: 2, color, alpha: 0.2 });
      }
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
        view = new UnitView(u, u.id === this.playerId);
        this.views.set(u.id, view);
        this.unitLayer.addChild(view.root);
      }
      const p = renderPos(u);
      const s = this.camera.worldToScreen(p);
      view.root.position.set(s.x, s.y);
      view.root.zIndex = p.y;
      view.update(u, this.world.isAlive(u), this.camera.zoom, dt);
    }
  }

  // --- missiles and hit sparks (screen space, lifted off the floor) --------

  private drawAir(projectilePos: ProjectilePos, dt: number): void {
    const g = this.air.clear();
    const z = this.camera.zoom;
    const lift = MISSILE_HEIGHT * z;

    for (const p of this.world.projectiles) {
      const s = this.camera.worldToScreen(projectilePos(p));
      s.y -= lift;
      const color = teamColor(p.team);
      const light = teamLight(p.team);
      if (p.kind === 'homing') {
        // Auto-attacks are small; ability bolts (the blink's) glow brighter.
        const ability = p.source !== 'attack';
        g.circle(s.x, s.y, (ability ? 20 : 13) * z).fill({ color: ability ? 0x9be7ff : color, alpha: 0.35 });
        g.circle(s.x, s.y, (ability ? 9 : 7) * z).fill(ability ? 0xffffff : light);
        continue;
      }
      const d = normalize({ x: p.dir.x, y: p.dir.y * TILT });
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
      f.text.position.set(s.x + f.drift * t, s.y - 125 * z - 50 * t);
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

function drawArena(): Graphics {
  const { width: W, height: H } = WORLD_SIZE;
  const g = new Graphics();
  g.rect(-2000, -2000, W + 4000, H + 4000).fill(0x0d1a12);
  const tile = 200;
  for (let x = 0; x < W; x += tile) {
    for (let y = 0; y < H; y += tile) {
      g.rect(x, y, tile, tile).fill((x / tile + y / tile) % 2 ? 0x2d5a37 : 0x315f3b);
    }
  }
  g.poly([W * 0.4, 0, W * 0.52, 0, W * 0.6, H, W * 0.48, H]).fill({ color: 0x2b5566, alpha: 0.55 });
  g.rect(0, 0, W, H).stroke({ width: 14, color: 0x0a120c });
  return g;
}

class UnitView {
  readonly root = new Container();
  pop = 0;
  flash = 0;
  private readonly body = new Graphics();
  private readonly flashBody = new Graphics();
  private readonly weapon = new Graphics();
  private readonly bars = new Graphics();
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
    name.position.set(0, -r * 3.3 - 14);
    this.status = new Text({
      text: '',
      style: { fontFamily: FONT, fontSize: 20, fontWeight: 'bold', fill: COLORS.text, stroke: { color: 0x000000, width: 4 } },
    });
    this.status.anchor.set(0.5);
    this.status.position.set(0, -r * 1.2);
    this.root.addChild(shadow, this.body, this.flashBody, this.weapon, this.bars, name, this.status);
  }

  update(unit: Unit, alive: boolean, zoom: number, dt: number): void {
    const r = bodyRadius(unit.def);
    this.pop = Math.max(0, this.pop - dt * 6);
    this.flash = Math.max(0, this.flash - dt * 8);
    this.root.scale.set(zoom * (1 + this.pop * 0.1));
    this.root.alpha = alive ? 1 : 0.3;
    this.flashBody.alpha = this.flash * 0.8;
    this.status.text = alive ? '' : unit.respawnIn.toFixed(1);

    // Facing, drawn as a bow arm. It pulls back during the windup and snaps forward on release.
    const w = this.weapon.clear();
    const facing = angleOf({ x: Math.cos(unit.facing), y: Math.sin(unit.facing) * TILT });
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
    w.moveTo(hand.x, hand.y).lineTo(end.x, end.y).stroke({ width: 7, color, cap: 'round' });
    if (unit.cast) {
      const k = 1 - unit.cast.remaining / unit.cast.total;
      const orb = add(hand, scale(dir, r * 0.9));
      w.circle(orb.x, orb.y, 6 + 12 * k).fill({ color: teamLight(unit.team), alpha: 0.5 + 0.5 * k });
    }

    const b = this.bars.clear();
    if (!alive) return;
    const bw = 90;
    const bh = 10;
    const by = -r * 3.3;
    b.roundRect(-bw / 2 - 2, by - 2, bw + 4, bh + 8, 3).fill({ color: 0x0b0b0b, alpha: 0.85 });
    b.rect(-bw / 2, by, (bw * unit.hp) / unit.def.maxHp, bh).fill(this.isPlayer ? COLORS.hpAlly : COLORS.hpEnemy);
    for (let hp = 100; hp < unit.def.maxHp; hp += 100) {
      b.rect(-bw / 2 + (bw * hp) / unit.def.maxHp, by, 1, bh).fill({ color: 0x000000, alpha: 0.5 });
    }
    b.rect(-bw / 2, by + bh + 1, (bw * unit.mana) / unit.def.maxMana, 3).fill(COLORS.mana);
    // Passive attack-speed stacks as pips above the health bar.
    const stacks = unit.statuses.find((st) => st.kind === 'attackSpeed');
    if (stacks?.kind === 'attackSpeed') {
      for (let i = 0; i < stacks.stacks; i++) b.circle(-bw / 2 + 5 + i * 11, by - 7, 4).fill(COLORS.gold);
    }
  }
}

function drawBody(g: Graphics, r: number, main: number, light: number): void {
  g.roundRect(-r * 0.62, -r * 2, r * 1.24, r * 2, r * 0.55)
    .fill(main)
    .stroke({ width: 3, color: 0x0a0a0a, alpha: 0.6 });
  g.circle(0, -r * 2.15, r * 0.5)
    .fill(light)
    .stroke({ width: 3, color: 0x0a0a0a, alpha: 0.6 });
}
