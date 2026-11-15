/**
 * The status the server last returned. Never a predicted status, never a colour
 * without words: the chip carries the label, the tint and the dot.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { alpha, radius, size, statusTint, type as typeScale, weight } from '../theme';
import type { Status } from '../types';

interface StatusChipProps {
  status: Status;
  label: string;
}

export function StatusChip({ status, label }: StatusChipProps): React.JSX.Element {
  const tint = statusTint(status);
  return (
    <View
      accessible
      accessibilityLabel={`Status: ${label}`}
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      style={[
        styles.chip,
        { backgroundColor: alpha(tint, 0.1), borderColor: alpha(tint, 0.34) },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <Text maxFontSizeMultiplier={1.3} style={[styles.label, { color: tint }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 30,
    paddingHorizontal: 11,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  dot: {
    width: size.dot,
    height: size.dot,
    borderRadius: size.dot / 2,
    marginEnd: 7,
  },
  label: {
    fontSize: typeScale.meta,
    fontWeight: weight.medium,
    letterSpacing: 0.2,
  },
});
