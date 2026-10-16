import { parseSummoners } from '../net/protocol';
import { ABILITY_SLOTS, DEFAULT_SUMMONERS, PLAYABLE, type AbilitySlot, type SummonerId, type SummonerSlot } from '../sim/defs';

/**
 * LoL's three cast modes:
 * - normal: press the key to show the indicator, left-click to cast (right-click or the key again cancels)
 * - quickIndicator: hold the key to aim, release to cast (right-click cancels)
 * - quick: cast at the cursor the moment the key goes down
 */
export type CastMode = 'normal' | 'quickIndicator' | 'quick';

export const CAST_MODES: { value: CastMode; label: string; hint: string }[] = [
  { value: 'quick', label: 'Quick cast', hint: 'Casts at the cursor on key press. No indicator.' },
  { value: 'quickIndicator', label: 'Quick cast with indicator', hint: 'Hold to aim, release to cast.' },
  { value: 'normal', label: 'Normal cast', hint: 'Press to aim, left-click to cast.' },
];

export interface Settings {
  /** Champion id from PLAYABLE. */
  champion: string;
  /** Used by every slot without an override. */
  castMode: CastMode;
  /** Per-key overrides; null means "use the default". */
  slotCastModes: Record<AbilitySlot, CastMode | null>;
  /** LoL's "Default Camera Mode": whether the camera starts locked to your champion. */
  cameraLocked: boolean;
  /** LoL's "Camera Lock Mode": offset toward the enemy side, or your champion dead center. */
  cameraLockMode: CameraLockMode;
  /** LoL's "Auto Attack": when idle, attack enemies that come into range. */
  autoAttack: boolean;
  /** LoL's "Attack Move on Cursor": A-click targets the enemy nearest the cursor first. */
  attackMoveOnCursor: boolean;
  /** Summoner spells on D and F; always two different ones. */
  summoners: Record<SummonerSlot, SummonerId>;
}

export type CameraLockMode = 'perSide' | 'fixed';

const STORAGE_KEY = '1v1me.settings';

export const DEFAULT_SETTINGS: Settings = {
  champion: PLAYABLE[0].id,
  castMode: 'quickIndicator',
  slotCastModes: { Q: null, W: null, E: null, R: null },
  cameraLocked: false,
  cameraLockMode: 'perSide',
  autoAttack: true,
  attackMoveOnCursor: false,
  summoners: { ...DEFAULT_SUMMONERS },
};

const isCastMode = (v: unknown): v is CastMode => CAST_MODES.some((m) => m.value === v);

export function castModeFor(settings: Settings, slot: AbilitySlot): CastMode {
  return settings.slotCastModes[slot] ?? settings.castMode;
}

/** Reads saved settings, falling back to defaults for anything missing or invalid. */
export function loadSettings(): Settings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    // Storage blocked or corrupt: play with defaults.
  }
  const saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  const slotCastModes = { ...DEFAULT_SETTINGS.slotCastModes };
  for (const slot of ABILITY_SLOTS) {
    const mode = saved.slotCastModes?.[slot];
    if (isCastMode(mode)) slotCastModes[slot] = mode;
  }
  const champion = PLAYABLE.some((c) => c.id === saved.champion) ? saved.champion! : DEFAULT_SETTINGS.champion;
  const cameraLocked = typeof saved.cameraLocked === 'boolean' ? saved.cameraLocked : DEFAULT_SETTINGS.cameraLocked;
  const cameraLockMode = saved.cameraLockMode === 'fixed' || saved.cameraLockMode === 'perSide' ? saved.cameraLockMode : DEFAULT_SETTINGS.cameraLockMode;
  const flag = (key: 'autoAttack' | 'attackMoveOnCursor') => (typeof saved[key] === 'boolean' ? saved[key] : DEFAULT_SETTINGS[key]);
  return {
    champion,
    castMode: isCastMode(saved.castMode) ? saved.castMode : DEFAULT_SETTINGS.castMode,
    slotCastModes,
    cameraLocked,
    cameraLockMode,
    autoAttack: flag('autoAttack'),
    attackMoveOnCursor: flag('attackMoveOnCursor'),
    summoners: parseSummoners(saved.summoners),
  };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or blocked storage: the settings still apply for this visit.
  }
}
