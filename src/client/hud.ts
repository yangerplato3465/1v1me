import { Container, Graphics, Text } from 'pixi.js';
import { clamp } from '../sim/math';
import { ABILITY_SLOTS, BASIC_MAX_RANK, CS_TO_WIN, MAX_LEVEL, ULTIMATE_MAX_RANK, XP_FOR_LEVEL, atRank, type AbilityDef, type AbilitySlot } from '../sim/defs';
import { attackSpeedOf, canRankUp, type Unit } from '../sim/world';
import { COLORS, FONT, MONO } from './theme';

export interface HudInfo {
  fps: number;
  tickRate: number;
  kills: number;
  deaths: number;
  /** Creep score: minions you last-hit. */
  cs: number;
  /** The enemy champion's creep score. */
  enemyCs: number;
  gold: number;
  cameraLocked: boolean;
  aiming: AbilitySlot | null;
  /** Mode / connection line shown top-right, e.g. "offline" or "online · room abc". */
  status: string;
}

const HELP = [
  'RMB      move / attack  (hold to keep moving)',
  'A + LMB  attack-move',
  'Q W E R  cast (modes below; RMB cancels aiming)',
  'S        stop (and pause auto-attack until your next order)',
  '`        hold: target champions only',
  'Ctrl/Alt + Q W E R   level up an ability (or click +); Ctrl+W needs full screen',
  'Space    hold to follow your champion (F1 too)',
  'Y        lock / unlock camera',
  'Arrows / screen edge / middle-drag   pan the camera',
].join('\n');

const SLOT = 64;
const SLOT_GAP = 10;
const PANEL_W = 340;
const PANEL_H = 200;
const PLUS = 22;

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
  /** Level-up button above the slot, shown while a skill point can go into it. */
  plus: Container;
}

function describeReach(a: AbilityDef): string {
  switch (a.kind) {
    case 'skillshot':
      return a.range >= 5000 ? 'global' : `${a.range} range`;
    case 'blink':
      return `${a.range} blink`;
    case 'shadow':
      return `${a.range} shadow · recast to swap`;
    case 'area':
      return `${a.radius} radius`;
    case 'deathMark':
      return `${a.range} targeted · recast to swap`;
  }
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
  private readonly farm = label(15, { bold: true, color: COLORS.text });
  private readonly goal = label(12, { color: COLORS.muted });
  private readonly level = label(20, { bold: true, color: COLORS.gold });
  private readonly points = label(14, { bold: true, color: COLORS.gold });
  /** Health and mana bars with "current / max" and regeneration per second, like LoL's HUD. */
  private readonly hpText = label(12, { bold: true });
  private readonly hpRegen = label(12, { bold: true, color: 0xbfe8c8 });
  private readonly manaText = label(11, { bold: true });
  private readonly manaRegen = label(11, { bold: true, color: 0xc6dcff });

  constructor(note: string, onLevelUp: (slot: AbilitySlot) => void) {
    this.help.text = note ? `${HELP}\n\n${note}` : HELP;
    this.help.position.set(16, 14);
    this.info.anchor.set(1, 0);
    this.score.anchor.set(0.5, 0);
    this.farm.anchor.set(0.5, 0);
    this.goal.anchor.set(0.5, 0);
    this.goal.text = `Win: first blood · first turret · first to ${CS_TO_WIN} CS`;
    this.level.anchor.set(0.5);
    this.points.anchor.set(0.5, 1);
    for (const t of [this.hpText, this.manaText]) t.anchor.set(0.5);
    for (const t of [this.hpRegen, this.manaRegen]) t.anchor.set(1, 0.5);
    this.root.addChild(
      this.panel, this.abilityInfo, this.attackState, this.help, this.info, this.score, this.farm, this.goal, this.level, this.points,
      this.hpText, this.hpRegen, this.manaText, this.manaRegen,
    );
    const slots = {} as Record<AbilitySlot, SlotLabels>;
    for (const slot of ABILITY_SLOTS) {
      const key = label(14, { bold: true });
      key.text = slot;
      const cooldown = label(24, { bold: true });
      cooldown.anchor.set(0.5);
      const plus = new Container();
      const button = new Graphics()
        .roundRect(0, 0, PLUS, PLUS, 5)
        .fill(0xc8aa6e)
        .stroke({ width: 2, color: 0x3b2f17 })
        .rect(PLUS / 2 - 1.5, 5, 3, PLUS - 10)
        .rect(5, PLUS / 2 - 1.5, PLUS - 10, 3)
        .fill(0x1b1408);
      plus.addChild(button);
      plus.eventMode = 'static';
      plus.cursor = 'pointer';
      plus.on('pointerdown', (e) => {
        e.stopPropagation();
        onLevelUp(slot);
      });
      this.root.addChild(key, cooldown, plus);
      slots[slot] = { key, cooldown, plus };
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

    // Level badge on the left edge, with the experience toward the next level around it.
    const bx0 = px - 4;
    const by0 = py + 46;
    const maxed = player.level >= MAX_LEVEL;
    const from = XP_FOR_LEVEL[player.level - 1];
    const xpProgress = maxed ? 1 : clamp((player.xp - from) / (XP_FOR_LEVEL[player.level] - from), 0, 1);
    g.circle(bx0, by0, 30).fill(0x0c1410).stroke({ width: 3, color: 0x3a3320 });
    if (xpProgress > 0) {
      g.moveTo(bx0, by0 - 30)
        .arc(bx0, by0, 30, -Math.PI / 2, -Math.PI / 2 + xpProgress * Math.PI * 2)
        .stroke({ width: 5, color: 0x9b6cff });
    }
    this.level.text = String(player.level);
    this.level.position.set(bx0, by0);

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
      labels.plus.position.set(sx + (SLOT - PLUS) / 2, py - PLUS - 6);
      labels.plus.visible = canRankUp(player, slot);
      if (!ability) {
        g.roundRect(sx, sy, SLOT, SLOT, 8).fill({ color: 0x141c18, alpha: 0.9 }).stroke({ width: 1, color: 0x2c3833 });
        labels.cooldown.text = '';
        return;
      }
      const rank = player.ranks[slot];
      const cd = player.cooldowns[slot];
      const ready = cd <= 0;
      const affordable = player.mana >= atRank(ability.manaCost, rank);
      const aimed = info.aiming === slot;
      if (rank === 0) {
        // Not learned yet.
        g.roundRect(sx, sy, SLOT, SLOT, 8).fill({ color: 0x10171a, alpha: 0.95 }).stroke({ width: 2, color: 0x2c3833 });
        labels.key.alpha = 0.45;
        labels.cooldown.text = '';
      } else {
        g.roundRect(sx, sy, SLOT, SLOT, 8)
          .fill(ready && affordable ? 0x1e4f7a : 0x1a2a36)
          .stroke({ width: aimed ? 3 : 2, color: aimed ? COLORS.gold : ready ? 0x7fc4ff : 0x44515c });
        if (!ready) g.rect(sx, sy, SLOT, (SLOT * cd) / atRank(ability.cooldown, rank)).fill({ color: 0x000000, alpha: 0.55 });
        labels.cooldown.text = ready ? '' : cd < 1 ? cd.toFixed(1) : String(Math.ceil(cd));
      }
      // Rank pips under the slot.
      const maxRank = slot === 'R' ? ULTIMATE_MAX_RANK : BASIC_MAX_RANK;
      const pipW = (SLOT - (maxRank - 1) * 3) / maxRank;
      for (let r = 0; r < maxRank; r++) {
        g.rect(sx + r * (pipW + 3), sy + SLOT + 4, pipW, 4).fill(r < rank ? COLORS.gold : 0x2c3833);
      }
    });

    this.points.text = player.skillPoints > 0 ? `${player.skillPoints} skill point${player.skillPoints > 1 ? 's' : ''} to spend` : '';
    this.points.position.set(px + PANEL_W / 2, py - PLUS - 12);

    const shownSlot = info.aiming ?? ABILITY_SLOTS.find((slot) => player.def.abilities[slot]);
    const shown = shownSlot && player.def.abilities[shownSlot];
    const shownRank = shownSlot ? Math.max(1, player.ranks[shownSlot]) : 1;
    const reach = !shown ? '' : describeReach(shown);
    const manaCost = shown ? atRank(shown.manaCost, shownRank) : 0;
    const cost = manaCost > 0 ? ` · ${manaCost} ${player.def.resource ?? 'mana'}` : '';
    const learned = shownSlot && player.ranks[shownSlot] > 0 ? `rank ${player.ranks[shownSlot]}` : 'not learned';
    this.abilityInfo.text = shown ? `${shownSlot} · ${shown.name} (${learned}) · ${reach} · ${atRank(shown.cooldown, shownRank)}s${cost}` : '';
    this.abilityInfo.position.set(px + 16, py + 92);

    // Health and mana (or energy), with their regeneration per second at the right end.
    const { maxHp, maxMana, hpRegen, manaRegen } = player.stats;
    const barX = px + 16;
    const barW = PANEL_W - 32;
    const hpY = py + 116;
    const hpH = 16;
    const manaY = hpY + hpH + 3;
    const manaH = 13;
    const hpFrac = alive ? clamp(player.hp / maxHp, 0, 1) : 0;
    g.rect(barX, hpY, barW, hpH).fill(0x0a0f0c).stroke({ width: 1, color: 0x2c3833 });
    g.rect(barX, hpY, barW * hpFrac, hpH).fill(COLORS.hpAlly);
    // Rounded like the max, but never 0 while alive.
    this.hpText.text = `${alive ? Math.max(1, Math.round(player.hp)) : 0} / ${Math.round(maxHp)}`;
    this.hpText.position.set(barX + barW / 2, hpY + hpH / 2);
    this.hpRegen.text = `+${hpRegen.toFixed(1)}`;
    this.hpRegen.position.set(barX + barW - 4, hpY + hpH / 2);
    const hasMana = maxMana > 0;
    this.manaText.visible = this.manaRegen.visible = hasMana;
    if (hasMana) {
      const manaFrac = alive ? clamp(player.mana / maxMana, 0, 1) : 0;
      g.rect(barX, manaY, barW, manaH).fill(0x0a0f0c).stroke({ width: 1, color: 0x2c3833 });
      g.rect(barX, manaY, barW * manaFrac, manaH).fill(player.def.resource === 'energy' ? COLORS.energy : COLORS.mana);
      this.manaText.text = `${alive ? Math.round(player.mana) : 0} / ${Math.round(maxMana)}`;
      this.manaText.position.set(barX + barW / 2, manaY + manaH / 2);
      this.manaRegen.text = `+${manaRegen.toFixed(1)}`;
      this.manaRegen.position.set(barX + barW - 4, manaY + manaH / 2);
    }

    // Auto-attack timer: the orange segment is the windup, the rest is free to move.
    const attackSpeed = attackSpeedOf(player);
    const period = 1 / attackSpeed;
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
    const stacks = player.statuses.find((s) => s.kind === 'attackSpeed');
    const passive =
      stacks?.kind === 'attackSpeed' && player.def.passive
        ? ` · ${player.def.passive.name} ×${stacks.stacks} (${stacks.remaining.toFixed(1)}s)`
        : '';
    this.attackState.text = `Auto attack · ${attackSpeed.toFixed(2)}/s · ${state}${passive}`;
    this.attackState.position.set(bx, by - 21);

    this.info.text = `${info.status}\n${Math.round(info.fps)} fps · sim ${info.tickRate} Hz · camera ${info.cameraLocked ? 'locked' : 'free'}`;
    this.info.position.set(screenW - 16, 14);
    this.score.text = `You ${info.kills}  —  ${info.deaths} Enemy`;
    this.score.position.set(screenW / 2, 12);
    this.farm.text = `CS ${info.cs}/${CS_TO_WIN} (enemy ${info.enemyCs})  ·  ${info.gold} gold`;
    this.goal.position.set(screenW / 2, 68);
    this.farm.position.set(screenW / 2, 44);
  }
}
