import { CS_TO_WIN, type WinReason } from '../sim/defs';

export interface EndStats {
  kills: number;
  deaths: number;
  cs: number;
  enemyCs: number;
  gold: number;
}

/** Why the match ended, from your side. */
export function describeEnd(victory: boolean, reason: WinReason): string {
  switch (reason) {
    case 'firstBlood':
      return victory ? 'First blood: the enemy champion died first.' : 'First blood: you died first.';
    case 'firstTurret':
      return victory ? 'First turret: you destroyed the enemy turret.' : 'First turret: your turret fell first.';
    case 'cs':
      return victory ? `First to ${CS_TO_WIN} CS: you got there first.` : `First to ${CS_TO_WIN} CS: the enemy got there first.`;
    case 'forfeit':
      return victory ? 'Forfeit: your opponent left the match.' : 'Forfeit: you left the match.';
  }
}

/**
 * LoL-style Victory / Defeat banner over the frozen game, with the match stats. "Back to
 * menu" (or Enter) reloads the page, which closes the game and any server connection.
 */
export function showEndScreen(victory: boolean, reason: WinReason, stats: EndStats): void {
  const root = document.createElement('div');
  root.id = 'end-screen';
  root.className = victory ? 'victory' : 'defeat';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');

  const title = document.createElement('h1');
  title.textContent = victory ? 'Victory' : 'Defeat';
  const why = document.createElement('p');
  why.className = 'why';
  why.textContent = describeEnd(victory, reason);
  const line = document.createElement('p');
  line.className = 'stats';
  line.textContent = `K/D ${stats.kills}/${stats.deaths} · CS ${stats.cs} (enemy ${stats.enemyCs}) · ${stats.gold} gold`;
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = 'Back to menu';
  const leave = () => location.reload();
  back.addEventListener('click', leave);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') leave();
  });

  root.append(title, why, line, back);
  document.body.append(root);
  // Not right away, so a click or key held from the fight doesn't skip the screen.
  back.disabled = true;
  setTimeout(() => {
    back.disabled = false;
    back.focus();
  }, 800);
}
