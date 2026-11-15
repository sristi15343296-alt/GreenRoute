/**
 * Four-segment forward progress: Scheduled · Accepted · En route · On scene.
 * Segments fill up to and including the current state. Cancelled responses show
 * no rail, because where dispatch stopped them is not ours to invent.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radius, size, spacing } from '../theme';
import type { Status } from '../types';

const FILLED: Record<Status, number> = {
  scheduled: 1,
  accepted: 2,
  in_transit: 3,
  on_scene: 4,
  completed: 4,
  cancelled: 0,
};

export function ProgressRail({ status }: { status: Status }): React.JSX.Element | null {
  const filled = FILLED[status];
  if (filled === 0) {
    return null;
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={styles.rail}
    >
      {[1, 2, 3, 4].map((segment) => (
        <View
          key={segment}
          style={[styles.segment, segment <= filled ? styles.filled : styles.empty]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    flexDirection: 'row',
    marginTop: spacing.md,
  },
  segment: {
    flex: 1,
    height: size.rail,
    borderRadius: radius.xs / 2,
    marginEnd: spacing.xs,
  },
  filled: {
    backgroundColor: colors.accent,
  },
  empty: {
    backgroundColor: colors.inset,
  },
});
