/**
 * The vehicle check that gates acceptance.
 *
 * Accepting a response used to be a single tap. Now the kit for this emergency
 * type has to be ticked first — the acceptance itself is still just the queued
 * action it always was.
 */

import React, { useMemo } from 'react';

import { copy } from '../copy';
import { equipmentItems } from '../equipment';
import { ACTION_LABELS, type Trip } from '../types';
import { TransitionCheckSheet } from './TransitionCheckSheet';

interface EquipmentCheckSheetProps {
  visible: boolean;
  trip: Trip;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (note: string, count: number) => void;
}

export function EquipmentCheckSheet({
  visible,
  trip,
  pending = false,
  onClose,
  onConfirm,
}: EquipmentCheckSheetProps): React.JSX.Element {
  const items = useMemo(() => equipmentItems(trip.emergency_type), [trip.emergency_type]);
  const subtitle =
    trip.emergency_type === null
      ? trip.reference
      : `${trip.reference} · ${trip.emergency_type} · before accepting`;

  return (
    <TransitionCheckSheet
      confirmLabel={ACTION_LABELS.accept}
      items={items}
      onClose={onClose}
      onConfirm={onConfirm}
      pending={pending}
      subtitle={subtitle}
      title={copy.checkTitle}
      visible={visible}
    />
  );
}
