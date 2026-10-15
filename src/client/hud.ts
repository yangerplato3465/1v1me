import { Container, Graphics, Text } from 'pixi.js';
import { clamp } from '../sim/math';
import { ABILITY_SLOTS, type AbilitySlot } from '../sim/defs';
import type { Unit } from '../sim/world';
import { COLORS, FONT, MONO } from './theme';

export interface HudInfo {
  fps: number;
  tickRate: number;
  kills: number;
  deaths: number;
  cameraLocked: boolean;
  aiming: AbilitySlot | null;
  /** Mode / connection line shown top-right, e.g. "offline" or "online · room abc". */
  status: string;
}

const HELP = [
  'RMB      move / attack  (hold to keep moving)',
  'A + LMB  attack-move',
  'Q W E R  hold to aim, release to cast  (RMB cancels)',
  'S        stop',
  'Space    center camera   Y  lock / unlock camera',
].join('\n');

const SLOT = 64;
const SLOT_GAP = 10;
const PANEL_W = 340;
const PANEL_H = 150;

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

interface SlotLabels {
  key: Text;
  cooldown: Text;
}

export class Hud {
  readonly root = new Container();
  private readonly panel = new Graphics();
  private readonly slots: Record<AbilitySlot, SlotLabels>;
  private readonly abilityInfo = label(13, { color: COLORS.muted });
  private readonly attackState = label(13);
  private readonly help = label(13, { mono: true, color: 0xd6dcd8 });
  private readonly info = label(13, { mono: true, color: COLORS.muted });
  private readonly score = label(22, { bold: true, color: COLORS.gold });

  constructor(note: string) {
    this.help.text = note ? `${HELP}\n\n${note}` : HELP;
    this.help.position.set(16, 14);
    this.info.anchor.set(1, 0);
    this.score.anchor.set(0.5, 0);
    this.root.addChild(this.panel, this.abilityInfo, this.attackState, this.help, this.info, this.score);
    const slots = {} as Record<AbilitySlot, SlotLabels>;
    for (const slot of ABILITY_SLOTS) {
      const key = label(14, { bold: true });
      key.text = slot;
      const cooldown = label(24, { bold: true });
      cooldown.anchor.set(0.5);
      this.root.addChild(key, cooldown);
      slots[slot] = { key, cooldown };
    }
    this.slots = slots;
  }

  update(screenW: number, screenH: number, player: Unit, alive: boolean, info: HudInfo): void {
    const px = Math.round(screenW / 2 - PANEL_W / 2);
    const py = Math.round(screenH - PANEL_H - 14);
    const g = this.panel.clear();
    g.roundRect(px, py, PANEL_W, PANEL_H, 12)
      .fill({ color: 0x0c1410, alpha: 0.9 })
      .stroke({ width: 2, color: COLORS.gold, alpha: 0.7 });

    // Ability slots with a top-down cooldown shade; empty slots are dimmed.
    const rowW = ABILITY_SLOTS.length * SLOT + (ABILITY_SLOTS.length - 1) * SLOT_GAP;
    ABILITY_SLOTS.forEach((slot, i) => {
      const ability = player.def.abilities[slot];
      const sx = px + (PANEL_W - rowW) / 2 + i * (SLOT + SLOT_GAP);
      const sy = py + 12;
      const labels = this.slots[slot];
      labels.key.position.set(sx + 6, sy + 3);
      labels.cooldown.position.set(sx + SLOT / 2, sy + SLOT / 2);
      labels.key.alpha = ability ? 1 : 0.35;
      if (!ability) {
        g.roundRect(sx, sy, SLOT, SLOT, 8).fill({ color: 0x141c18, alpha: 0.9 }).stroke({ width: 1, color: 0x2c3833 });
        labels.cooldown.text = '';
        return;
      }
      const cd = player.cooldowns[slot];
      const ready = cd <= 0;
      const affordable = player.mana >= ability.manaCost;
      const aimed = info.aiming === slot;
      g.roundRect(sx, sy, SLOT, SLOT, 8)
        .fill(ready && affordable ? 0x1e4f7a : 0x1a2a36)
        .stroke({ width: aimed ? 3 : 2, color: aimed ? COLORS.gold : ready ? 0x7fc4ff : 0x44515c });
      if (!ready) g.rect(sx, sy, SLOT, (SLOT * cd) / ability.cooldown).fill({ color: 0x000000, alpha: 0.55 });
      labels.cooldown.text = ready ? '' : cd < 1 ? cd.toFixed(1) : String(Math.ceil(cd));
    });

    const shownSlot = info.aiming ?? ABILITY_SLOTS.find((slot) => player.def.abilities[slot]);
    const shown = shownSlot && player.def.abilities[shownSlot];
    this.abilityInfo.text = shown
      ? `${shownSlot} · ${shown.name} · ${shown.range} range · ${shown.cooldown}s · ${shown.manaCost} mana`
      : '';
    this.abilityInfo.position.set(px + 16, py + 84);

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

    this.info.text = `${info.status}\n${Math.round(info.fps)} fps · sim ${info.tickRate} Hz · camera ${info.cameraLocked ? 'locked' : 'free'}`;
    this.info.position.set(screenW - 16, 14);
    this.score.text = `You ${info.kills}  —  ${info.deaths} Enemy`;
    this.score.position.set(screenW / 2, 12);
  }
}
