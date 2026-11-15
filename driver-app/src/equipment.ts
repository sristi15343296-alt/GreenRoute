/**
 * What has to be on the vehicle before the driver accepts, and what has to be
 * done before the response is closed.
 *
 * These lists are the app's own: dispatch sends an emergency type, not a kit.
 * A check is valid for twelve hours, after which the next acceptance asks again.
 */

export interface CheckItem {
  id: string;
  label: string;
  /** Readout shown on the right, when the item has one. */
  detail: string | null;
  /** Which block the item comes from: the base kit or the emergency type. */
  group: string;
}

export const CHECK_TTL_MS = 12 * 60 * 60 * 1000;

const BASE_KIT: CheckItem[] = [
  { id: 'oxygen', label: 'Oxygen cylinder', detail: 'Above 100 bar', group: 'Base kit' },
  { id: 'aed', label: 'AED & cardiac monitor', detail: 'Charged', group: 'Base kit' },
  { id: 'trauma', label: 'Trauma bag', detail: 'Sealed', group: 'Base kit' },
  { id: 'stretcher', label: 'Stretcher & straps', detail: null, group: 'Base kit' },
  { id: 'radio', label: 'Radio check', detail: 'Dispatch heard', group: 'Base kit' },
  { id: 'lights', label: 'Lights & siren', detail: null, group: 'Base kit' },
];

const BY_EMERGENCY: Record<string, CheckItem[]> = {
  fire: [
    { id: 'extinguisher', label: 'Extinguisher', detail: '2 units', group: 'Fire' },
    { id: 'scba', label: 'SCBA & spare cylinder', detail: null, group: 'Fire' },
    { id: 'hose', label: 'Hose & branch', detail: null, group: 'Fire' },
  ],
  hazard: [
    { id: 'suit', label: 'Hazmat suit', detail: 'Sealed', group: 'Hazmat' },
    { id: 'detector', label: 'Gas detector', detail: 'Calibrated', group: 'Hazmat' },
    { id: 'decon', label: 'Decontamination kit', detail: null, group: 'Hazmat' },
  ],
  collision: [
    { id: 'extrication', label: 'Extrication tools', detail: null, group: 'Collision' },
    { id: 'boards', label: 'Spinal boards', detail: null, group: 'Collision' },
  ],
  rescue: [
    { id: 'rope', label: 'Rope & harness', detail: null, group: 'Rescue' },
    { id: 'cutting', label: 'Cutting gear', detail: null, group: 'Rescue' },
  ],
  medical: [
    { id: 'monitor', label: 'Cardiac monitor', detail: 'Battery above 50%', group: 'Medical' },
    { id: 'drugs', label: 'Drugs bag', detail: 'Seal intact', group: 'Medical' },
  ],
  welfare: [
    { id: 'blankets', label: 'Blankets', detail: null, group: 'Welfare' },
    { id: 'water', label: 'Water & cups', detail: null, group: 'Welfare' },
  ],
};

/** Base kit plus whatever this emergency type adds. */
const ALIASES: Record<string, string> = {
  hazmat: 'hazard',
  hazardous: 'hazard',
  traffic: 'collision',
};

export function equipmentItems(emergencyType: string | null): CheckItem[] {
  const raw = (emergencyType ?? '').trim().toLowerCase();
  const key = ALIASES[raw] ?? raw;
  const extra = BY_EMERGENCY[key] ?? [];
  return [...BASE_KIT, ...extra];
}

/** Handover before closing: what is left on the vehicle and at the scene. */
export function handoverItems(): CheckItem[] {
  return [
    { id: 'handover-note', label: 'Handover given', detail: 'To receiving crew', group: 'Scene' },
    { id: 'belongings', label: 'Patient belongings', detail: null, group: 'Scene' },
    { id: 'equipment-back', label: 'Equipment retrieved', detail: null, group: 'Vehicle' },
    { id: 'restock', label: 'Vehicle restocked', detail: null, group: 'Vehicle' },
    { id: 'scene-safe', label: 'Scene left safe', detail: null, group: 'Scene' },
    { id: 'dispatch-note', label: 'Dispatch updated', detail: null, group: 'Dispatch' },
  ];
}

/** A check older than the TTL no longer counts. */
export function checkIsFresh(at: string | null | undefined, nowMs: number): boolean {
  if (at === null || at === undefined) {
    return false;
  }
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return nowMs - parsed < CHECK_TTL_MS;
}

/** Expiry clock for a check, e.g. "20:31". */
export function checkExpiresAt(at: string): Date {
  return new Date(Date.parse(at) + CHECK_TTL_MS);
}

