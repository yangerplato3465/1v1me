import { Container, Graphics, Text } from 'pixi.js';
import { clamp } from '../sim/math';
import type { Unit } from '../sim/world';
import { COLORS, FONT, MONO } from './theme';

export interface HudInfo {
  fps: number;
  tickRate: number;
  kills: number;
  deaths: number;
  cameraLocked: boolean;
  qHeld: boolean;
}

const HELP = [
  'RMB      move / attack  (hold to keep moving)',
  'A + LMB  attack-move',
  'Q        hold to aim, release to fire  (RMB cancels)',
  'S        stop',
  'Space    center camera   Y  lock / unlock camera',
  '',
  'The bot strafes and throws its Q at you. Dodge it.',
].join('\n');

const SLOT = 64;
const PANEL_W = 380;
const PANEL_H = 128;

function label(size: number, opts: { color?: number; bold?: boolean; mono?: boolean } = {}): Text {
  return new Text({
    text: '',
    style: {
      fontFamily: opts.mono ? MONO : FONT,
      fontSize: size,
      fill: opts.color ?? COLORS.text,
      fontWeight: opts.bold ? 'bold' : 'normal',
      stroke: { color: 0x000000, width: 3 },
      lineHeight: size * 1.45,
    },
  });
}

export class Hud {
  readonly root = new Container();
  private readonly panel = new Graphics();
  private readonly qKey = label(14, { bold: true });
  private readonly qCooldown = label(24, { bold: true });
  private readonly qTitle = label(17, { bold: true });
  private readonly qStats = label(13, { color: COLORS.muted });
  private readonly attackState = label(13);
  private readonly help = label(13, { mono: true, color: 0xd6dcd8 });
  private readonly info = label(13, { mono: true, color: COLORS.muted });
  private readonly score = label(22, { bold: true, color: COLORS.gold });

  constructor() {
    this.help.text = HELP;
    this.help.position.set(16, 14);
    this.info.anchor.set(1, 0);
    this.score.anchor.set(0.5, 0);
    this.qCooldown.anchor.set(0.5);
    this.root.addChild(
      this.panel,
      this.qKey,
      this.qCooldown,
      this.qTitle,
      this.qStats,
      this.attackState,
      this.help,
      this.info,
      this.score,
    );
  }

  update(screenW: number, screenH: number, player: Unit, alive: boolean, info: HudInfo): void {
    const q = player.def.q;
    const px = Math.round(screenW / 2 - PANEL_W / 2);
    const py = Math.round(screenH - PANEL_H - 14);
    const g = this.panel.clear();
    g.roundRect(px, py, PANEL_W, PANEL_H, 12)
      .fill({ color: 0x0c1410, alpha: 0.9 })
      .stroke({ width: 2, color: COLORS.gold, alpha: 0.7 });

    // Q slot with a top-down cooldown shade.
    const sx = px + 16;
    const sy = py + 12;
    const ready = player.qCooldown <= 0;
    const affordable = player.mana >= q.manaCost;
    g.roundRect(sx, sy, SLOT, SLOT, 8)
      .fill(ready && affordable ? 0x1e4f7a : 0x1a2a36)
      .stroke({ width: info.qHeld ? 3 : 2, color: info.qHeld ? COLORS.gold : ready ? 0x7fc4ff : 0x44515c });
    if (!ready) g.rect(sx, sy, SLOT, (SLOT * player.qCooldown) / q.cooldown).fill({ color: 0x000000, alpha: 0.55 });
    this.qKey.text = 'Q';
    this.qKey.position.set(sx + 6, sy + 3);
    this.qCooldown.text = ready ? '' : player.qCooldown < 1 ? player.qCooldown.toFixed(1) : String(Math.ceil(player.qCooldown));
    this.qCooldown.position.set(sx + SLOT / 2, sy + SLOT / 2);
    this.qTitle.text = q.name;
    this.qTitle.position.set(sx + SLOT + 14, sy + 6);
    this.qStats.text = `${q.range} range · ${q.cooldown}s cd · ${q.manaCost} mana${affordable ? '' : '  (no mana)'}`;
    this.qStats.position.set(sx + SLOT + 14, sy + 34);

    // Auto-attack timer: the orange segment is the windup, the rest is free to move.
    const period = 1 / player.def.attackSpeed;
    const wf = player.def.windupPct;
    const bx = px + 16;
    const by = py + PANEL_H - 22;
    const bw = PANEL_W - 32;
    const bh = 8;
    let elapsed: number;
    let state: string;
    if (!alive) {
      elapsed = 0;
      state = 'dead';
    } else if (player.windup) {
      elapsed = player.windup.total - player.windup.remaining;
      state = 'WINDUP · moving now cancels the attack';
    } else if (player.attackCooldown > 0) {
      elapsed = period - player.attackCooldown;
      state = 'BACKSWING · free to move (orb-walk)';
    } else {
      elapsed = period;
      state = 'READY';
    }
    const progress = clamp(elapsed / period, 0, 1);
    g.rect(bx, by, bw * wf, bh).fill({ color: COLORS.windup, alpha: 0.25 });
    g.rect(bx + bw * wf, by, bw * (1 - wf), bh).fill({ color: 0x8a9aa6, alpha: 0.2 });
    g.rect(bx, by, bw * Math.min(progress, wf), bh).fill(COLORS.windup);
    if (progress > wf) g.rect(bx + bw * wf, by, bw * (progress - wf), bh).fill(0xdfe7ee);
    this.attackState.text = `Auto attack · ${player.def.attackSpeed.toFixed(2)}/s · ${state}`;
    this.attackState.position.set(bx, by - 21);

    this.info.text = `${Math.round(info.fps)} fps · sim ${info.tickRate} Hz · camera ${info.cameraLocked ? 'locked' : 'free'}`;
    this.info.position.set(screenW - 16, 14);
    this.score.text = `You ${info.kills}  —  ${info.deaths} Bot`;
    this.score.position.set(screenW / 2, 12);
  }
}
