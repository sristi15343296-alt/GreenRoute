/**
 * Seed data for the parts of the app the dispatch API does not serve.
 *
 * There is no `/history`, no `/checklist` and no `/shift` endpoint on this
 * server, so those screens would be permanently empty. Everything here is
 * clearly labelled as demo in the UI, lives only in memory, and never touches
 * the outbox, the token or the assignment.
 *
 * Replace this module with a real fetch the day dispatch grows those endpoints;
 * nothing else has to change.
 */

export interface HistoryEntry {
  id: string;
  reference: string;
  destination: string;
  /** `done` closes the response, `cancelled` is dispatch pulling it. */
  outcome: 'done' | 'cancelled';
  day: 'today' | 'yesterday' | 'earlier';
  /** Time from acceptance to the closing event. */
  durationLabel: string;
  window: string;
}

export const DEMO_HISTORY: HistoryEntry[] = [
  {
    id: 'gr-2025',
    reference: 'GR-2025',
    destination: 'Saki Naka Industrial Estate',
    outcome: 'done',
    day: 'today',
    durationLabel: '6m 12s',
    window: '08:37 → 08:43',
  },
  {
    id: 'gr-2023',
    reference: 'GR-2023',
    destination: 'Marol Fire Station',
    outcome: 'done',
    day: 'today',
    durationLabel: '9m 41s',
    window: '07:52 → 08:02',
  },
  {
    id: 'gr-2022',
    reference: 'GR-2022',
    destination: 'Kurla Junction',
    outcome: 'cancelled',
    day: 'today',
    durationLabel: '—',
    window: '07:20',
  },
  {
    id: 'gr-2018',
    reference: 'GR-2018',
    destination: 'Andheri East Metro',
    outcome: 'done',
    day: 'yesterday',
    durationLabel: '7m 03s',
    window: '19:04 → 19:11',
  },
  {
    id: 'gr-2017',
    reference: 'GR-2017',
    destination: 'Powai Lake Road',
    outcome: 'done',
    day: 'yesterday',
    durationLabel: '5m 28s',
    window: '18:22 → 18:27',
  },
  {
    id: 'gr-2009',
    reference: 'GR-2009',
    destination: 'Vikhroli Depot',
    outcome: 'done',
    day: 'earlier',
    durationLabel: '11m 40s',
    window: '16:10 → 16:22',
  },
];

export interface ChecklistItem {
  id: string;
  label: string;
  /** Readout shown on the right of the row, when the item has one. */
  detail: string | null;
  done: boolean;
}

export const DEMO_CHECKLIST: ChecklistItem[] = [
  { id: 'lights', label: 'Lights & siren', detail: null, done: true },
  { id: 'oxygen', label: 'Oxygen cylinder', detail: '14.2 bar', done: true },
  { id: 'stretcher', label: 'Stretcher & straps', detail: null, done: true },
  { id: 'radio', label: 'Radio check', detail: null, done: true },
  { id: 'fridge', label: 'Fridge temperature', detail: '4°C', done: true },
  { id: 'fuel', label: 'Fuel above 50%', detail: null, done: true },
  { id: 'consumables', label: 'Consumables stocked', detail: '2 items low', done: false },
  { id: 'tyres', label: 'Tyre & brake check', detail: null, done: false },
];
