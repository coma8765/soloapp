import { buttonDown } from './physical-room-input.js';

export function keyboardQualityShortcut(event) {
  return (
    event.code === 'KeyQ' &&
    !event.defaultPrevented &&
    !event.repeat &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.target?.closest?.('input,textarea,select,[contenteditable]')
  );
}

// xr-standard left secondary face button: Y on Quest. No system/menu buttons.
export function xrQualityPressed(sources) {
  return [...(sources || [])].some(
    (source) =>
      source.handedness === 'left' &&
      source.gamepad?.mapping === 'xr-standard' &&
      buttonDown(source.gamepad.buttons[5]),
  );
}
