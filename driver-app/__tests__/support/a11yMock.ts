/**
 * Test-only stand-in for the a11y hooks, so reduce-transparency can be flipped
 * per test without touching the real AccessibilityInfo subscription.
 */

const actual = jest.requireActual('../../src/a11y') as typeof import('../../src/a11y');

let reduceTransparency = false;
let reduceMotion = false;

export function setReduceTransparency(value: boolean): void {
  reduceTransparency = value;
}

export function setReduceMotion(value: boolean): void {
  reduceMotion = value;
}

export function useReduceTransparency(): boolean {
  return reduceTransparency;
}

export function useReduceMotion(): boolean {
  return reduceMotion;
}

export const useAnnouncements = actual.useAnnouncements;
