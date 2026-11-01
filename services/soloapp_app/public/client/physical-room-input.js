// Edge-triggered, release-to-arm shortcuts shared by desktop and WebXR.
// Never use reserved system/menu buttons on XR controllers.
export class RoomShortcut {
  constructor() {
    this.reset();
  }

  reset() {
    this.armed = false;
  }

  poll(down, allowed = true) {
    if (!allowed) {
      this.reset();
      return false;
    }
    if (!down) {
      this.armed = true;
      return false;
    }
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }
}

export const buttonDown = (button) =>
  !!button && (button.pressed || button.value > 0.5);

export function xrRoomShortcut(sources) {
  const hands = new Set();
  for (const source of sources || []) {
    if (
      source.gamepad?.mapping === 'xr-standard' &&
      buttonDown(source.gamepad.buttons[1])
    )
      hands.add(source.handedness);
  }
  return hands.has('left') && hands.has('right');
}

export function keyboardRoomShortcut(event) {
  return (
    event.code === 'KeyP' &&
    !event.repeat &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.target?.closest?.('input,textarea,select,[contenteditable]')
  );
}
