import {
  encodeImeCommitForKitty,
  type ImeCommitKeyPress,
  type ImeCommitKittyEncoding
} from './terminal-ime-kitty-commit-encoding'
import { getLayoutCharacterForCode } from '../../../../lib/keyboard-layout/layout-base-character'

// fcitx4 on Wayland can compute committed punctuation from a stale Shift layer; the repair joins the commit encoding here so the forwarder only pairs presses with commits.

/** A shiftless, caps-free press committing exactly its own shifted-layer glyph contradicts the keyboard, so publish the base character. */
function resolveStaleShiftCommittedText(press: ImeCommitKeyPress, committedText: string): string {
  if (
    press.shiftKey ||
    press.capsLock === true ||
    !press.code ||
    Array.from(committedText).length !== 1
  ) {
    return committedText
  }
  const shifted = getLayoutCharacterForCode(press.code, true)
  if (shifted === undefined || committedText !== shifted) {
    return committedText
  }
  const base = getLayoutCharacterForCode(press.code, false)
  return base !== undefined && base !== shifted ? base : committedText
}

export type RepairedImeCommitEncoding = ImeCommitKittyEncoding & {
  /** The commit text after stale-shift repair; the raw-text fallback sends it. */
  committedText: string
}

/** Read negotiated flags once at commit so the release matches the press’s negotiation, and repair a stale Shift layer before encoding. */
export function encodeRepairedImeCommit(
  press: ImeCommitKeyPress,
  getKittyKeyboardFlags: (() => number) | undefined,
  committedText: string
): RepairedImeCommitEncoding {
  const repaired = resolveStaleShiftCommittedText(press, committedText)
  const encoding = encodeImeCommitForKitty(press, getKittyKeyboardFlags?.() ?? 0, {
    committedText: repaired,
    layoutCharacterForCode: getLayoutCharacterForCode
  })
  return { ...encoding, committedText: repaired }
}
