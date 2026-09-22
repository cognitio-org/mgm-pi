// Minimal Gamepad API polling helper shared by both games. No dependency, no event model beyond
// what the browser gives us -- the Gamepad API only exposes state via polling
// (navigator.getGamepads()), so both games call readGamepadDirection()/readGamepadButtons() once
// per animation frame from inside their own input-merging step.

export interface GamepadDirection {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export interface GamepadButtons {
  fire: boolean; // face button (A/cross) or right trigger
  pause: boolean; // start/menu button
  connected: boolean;
}

const DEADZONE = 0.35;

function firstConnectedPad(): Gamepad | null {
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (p && p.connected) return p;
    }
    return null;
  } catch {
    return null;
  }
}

/** Reads d-pad + left-stick vertical/horizontal axes from the first connected gamepad. Safe to
 * call every frame; returns all-false when no pad is connected or the API is unavailable. */
export function readGamepadDirection(): GamepadDirection {
  const pad = firstConnectedPad();
  if (!pad) return { up: false, down: false, left: false, right: false };
  const axisY = pad.axes[1] ?? 0;
  const axisX = pad.axes[0] ?? 0;
  const dpadUp = pad.buttons[12]?.pressed ?? false;
  const dpadDown = pad.buttons[13]?.pressed ?? false;
  const dpadLeft = pad.buttons[14]?.pressed ?? false;
  const dpadRight = pad.buttons[15]?.pressed ?? false;
  return {
    up: dpadUp || axisY < -DEADZONE,
    down: dpadDown || axisY > DEADZONE,
    left: dpadLeft || axisX < -DEADZONE,
    right: dpadRight || axisX > DEADZONE,
  };
}

export function readGamepadButtons(): GamepadButtons {
  const pad = firstConnectedPad();
  if (!pad) return { fire: false, pause: false, connected: false };
  const fire = (pad.buttons[0]?.pressed ?? false) || (pad.buttons[7]?.pressed ?? false);
  const pause = pad.buttons[9]?.pressed ?? false;
  return { fire, pause, connected: true };
}

export function isGamepadConnected(): boolean {
  return firstConnectedPad() !== null;
}
