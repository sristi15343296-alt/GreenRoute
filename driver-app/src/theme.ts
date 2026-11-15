import type { TextStyle, ViewStyle } from 'react-native';

import type { Priority, Status } from './types';

/**
 * Design tokens for the map-first shell.
 *
 * Dark only. The palette is a near-monochrome core with one accent, so the
 * driver reads colour as meaning rather than decoration. `rim` is deliberately
 * bright: a glass panel measures 1.07:1 against the canvas at every alpha, so
 * the rim is what makes the surface visible at all (3.22:1 at 0.35 white).
 * Flat cards use `border` instead, because a 0.35 rim on every card is noise.
 */
export const colors = {
  canvas: '#0b0c0b',
  raised: '#141614',
  inset: '#0f110f',
  /** Glass rim. Measured 3.22:1 against the glass surface. */
  rim: 'rgba(255,255,255,0.35)',
  /** Flat-card border. Decorative, not load-bearing. */
  border: 'rgba(255,255,255,0.14)',
  hairline: 'rgba(255,255,255,0.075)',
  accent: '#c9f94c',
  onAccent: '#0a0b08',
  focus: '#d8ff6a',
  text: '#eef1ea',
  secondary: 'rgba(238,241,234,0.62)',
  /** Raised from 0.34: measured 2.88:1, below the 3:1 non-text floor. */
  disabled: 'rgba(238,241,234,0.45)',
  /* Semantic surfaces, so no screen invents its own hex. */
  warningSurface: '#1c1410',
  warningBorder: '#3a2a20',
  warning: '#e3b04b',
  danger: '#e5674f',
  dangerBorder: '#5a2a20',
} as const;

/** Glass is confined to the navigation and overlay layers. See Glass.tsx. */
export const glass = {
  tint: 'rgba(18,20,18,0.78)',
  tintStrong: 'rgba(15,17,15,0.92)',
  /** Android has no backdrop blur; this is the solid stand-in. */
  android: 'rgba(20,22,20,0.88)',
  /** Reduce Transparency fallback. */
  opaque: '#141614',
  sheen: 'rgba(255,255,255,0.07)',
  sheenStrong: 'rgba(255,255,255,0.10)',
  blurIntensity: 45,
  sheetBlurIntensity: 60,
} as const;

/** The map's own backdrop; brighter than the app canvas so tiles blend in. */
export const mapSurface = '#101513';

/** Pressed state for flat content rows. */
export const pressed = '#191c19';

/** The primary action's fill, top to bottom. */
export const accentGradient = ['#d7ff6a', '#c0f03f'] as const;

/** Ambient fields the map and glass sit above. */
export const aura = {
  accent: 'rgba(201,249,76,0.06)',
  cool: 'rgba(94,168,230,0.05)',
} as const;

function elevation(
  shadowOpacity: number,
  shadowRadius: number,
  lift: number,
  androidElevation: number
): ViewStyle {
  return {
    shadowColor: '#000000',
    shadowOpacity,
    shadowRadius,
    shadowOffset: { width: 0, height: lift },
    elevation: androidElevation,
  };
}

export const depth = {
  pill: elevation(0.55, 18, 6, 6),
  sheet: elevation(0.6, 40, -14, 16),
  toast: elevation(0.5, 20, 8, 8),
} as const;

/** Top bar only; sheets use the raised surface. */
export const barTint = 'rgba(11,12,11,0.92)';
/** Sheets dim the backdrop by 60%. */
// 0.60 left the dock's accent button legible through an open sheet on Android,
// where there is no blur behind the scrim to break it up.
export const scrim = 'rgba(0,0,0,0.72)';

const STATUS_TINTS: Record<Status, string> = {
  // `scheduled` is the neutral state and uses the console's neutral tint.
  scheduled: '#8d938a',
  accepted: '#5ea8e6',
  in_transit: '#e3b04b',
  on_scene: '#a98bf5',
  completed: '#6fd08c',
  cancelled: '#e5674f',
};

export function statusTint(status: Status): string {
  return STATUS_TINTS[status];
}

/** Tint a hex colour for chip backgrounds and rims. */
export function alpha(hex: string, opacity: number): string {
  const clean = hex.replace('#', '');
  const red = Number.parseInt(clean.slice(0, 2), 16);
  const green = Number.parseInt(clean.slice(2, 4), 16);
  const blue = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${opacity})`;
}

const PRIORITY_TINTS: Record<Priority, string> = {
  critical: '#e5674f',
  high: '#e3b04b',
  normal: '#8d938a',
};

export function priorityTint(priority: Priority): string {
  return PRIORITY_TINTS[priority];
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  xxl: 30,
  pill: 999,
} as const;

/**
 * Type scale sized for a glance, not a read. Minimum 15, with the three
 * decision-carrying strings (reference, destination, primary action) at 20+.
 */
export const type = {
  meta: 15,
  secondary: 17,
  body: 20,
  section: 24,
  hero: 32,
} as const;

/** Line height at 1.45x, snapped to the 4pt grid. */
export function leadingFor(size: number): number {
  return Math.round((size * 1.45) / 4) * 4;
}

/** Paired with `type` above: 20 / 24 / 28 / 36 / 48. */
export const leading = {
  meta: leadingFor(type.meta),
  secondary: leadingFor(type.secondary),
  body: leadingFor(type.body),
  section: leadingFor(type.section),
  hero: leadingFor(type.hero),
} as const;

/**
 * Three weights only. Medium emphasises; semibold is reserved for the one
 * primary action on screen, because heavy text is harder to read in motion.
 */
export const weight = {
  regular: '400',
  medium: '500',
  strong: '600',
} as const;

export const size = {
  primary: 58,
  primaryLarge: 64,
  target: 48,
  iconButton: 48,
  chip: 32,
  banner: 44,
  dot: 8,
  rail: 4,
  pill: 60,
} as const;

/** Times and references are set in tabular numerals. */
export const tabular: TextStyle = { fontVariant: ['tabular-nums'] };

/** Motion: 160 push, 140 press, 120 chip. Nothing bounces. */
export const motion = {
  push: 160,
  press: 140,
  chip: 120,
  toast: 2500,
} as const;

/** Tablet and landscape content column. */
export const contentMaxWidth = 600;

/** Stage chrome: floating bars sit this far from the screen edge. */
export const inset = 12;
/** Scroll content clears the floating pill. */
export const stageTop = 84;
/** Scroll content clears the floating dock. */
export const stageBottom = 168;
