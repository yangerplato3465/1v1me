/**
 * Full screen for the whole page. In Chromium browsers it also locks the keyboard, so keys
 * the browser normally keeps for itself (Ctrl+W, Ctrl+Q…) reach the game; Escape then has
 * to be held to leave full screen, and the browser says so.
 */

type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
const keyboard = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

export const fullscreenSupported = (): boolean => !!document.fullscreenEnabled;

export const isFullscreen = (): boolean => !!document.fullscreenElement;

export async function toggleFullscreen(): Promise<void> {
  if (isFullscreen()) {
    keyboard()?.unlock?.();
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  // Best effort: not every browser has it, and it can be refused.
  await keyboard()?.lock?.().catch(() => {});
}

/**
 * Wires a button to toggle full screen and keep its label in step (also when the player
 * leaves with Escape). Hides it where full screen isn't available, such as iPhone Safari.
 */
export function setupFullscreenButton(button: HTMLButtonElement, labels = { enter: 'Full screen', exit: 'Exit full screen' }): void {
  if (!fullscreenSupported()) {
    button.hidden = true;
    return;
  }
  const show = () => {
    button.textContent = isFullscreen() ? labels.exit : labels.enter;
    button.setAttribute('aria-pressed', String(isFullscreen()));
  };
  button.addEventListener('click', () => {
    toggleFullscreen()
      .catch((err) => console.warn('Full screen was refused', err))
      .finally(() => button.blur()); // keep Space and keys for the game
  });
  document.addEventListener('fullscreenchange', show);
  show();
}
