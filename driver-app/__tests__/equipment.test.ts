import { CHECK_TTL_MS, checkExpiresAt, checkIsFresh, equipmentItems, handoverItems } from '../src/equipment';

describe('equipment kit', () => {
  it('always includes the base kit', () => {
    const items = equipmentItems(null);
    expect(items.length).toBeGreaterThanOrEqual(6);
    expect(items.map((item) => item.id)).toContain('oxygen');
    expect(items.map((item) => item.id)).toContain('aed');
  });

  it('adds the items this emergency type needs', () => {
    const fire = equipmentItems('fire');
    expect(fire.map((item) => item.id)).toContain('extinguisher');
    expect(fire.length).toBe(equipmentItems(null).length + 3);

    const hazard = equipmentItems('hazmat');
    expect(hazard.map((item) => item.id)).toContain('detector');
  });

  it('is case and whitespace tolerant, and unknown types are still valid', () => {
    expect(equipmentItems('  Fire ').length).toBe(equipmentItems('fire').length);
    expect(equipmentItems('unknown').length).toBe(equipmentItems(null).length);
  });

  it('never repeats an id, so every row is independently checkable', () => {
    for (const type of [null, 'fire', 'hazard', 'collision', 'rescue', 'medical', 'welfare']) {
      const ids = equipmentItems(type).map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const handover = handoverItems().map((item) => item.id);
    expect(new Set(handover).size).toBe(handover.length);
  });
});

describe('check freshness', () => {
  const at = '2026-11-13T08:00:00Z';

  it('counts a check inside twelve hours', () => {
    expect(checkIsFresh(at, Date.parse(at) + 60_000)).toBe(true);
    expect(checkIsFresh(at, Date.parse(at) + CHECK_TTL_MS - 1)).toBe(true);
  });

  it('expires it exactly at the boundary and after', () => {
    expect(checkIsFresh(at, Date.parse(at) + CHECK_TTL_MS)).toBe(false);
    expect(checkIsFresh(at, Date.parse(at) + CHECK_TTL_MS + 1)).toBe(false);
  });

  it('treats missing or unparseable timestamps as expired', () => {
    expect(checkIsFresh(null, Date.now())).toBe(false);
    expect(checkIsFresh('not a date', Date.now())).toBe(false);
  });

  it('reports the expiry twelve hours after the check', () => {
    expect(checkExpiresAt(at).toISOString()).toBe('2026-11-13T20:00:00.000Z');
  });
});
