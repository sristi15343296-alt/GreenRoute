/**
 * Loading placeholders for lists only. No shimmer, no motion.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

export function SkeletonRows({ count = 3 }: { count?: number }): React.JSX.Element {
  return (
    <View accessible accessibilityLabel="Loading">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={[styles.card, index > 0 && styles.spaced]}>
          <View style={[styles.line, styles.short]} />
          <View style={[styles.line, styles.long]} />
          <View style={[styles.line, styles.medium]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  spaced: {
    marginTop: spacing.md,
  },
  line: {
    height: 12,
    borderRadius: radius.xs,
    backgroundColor: colors.inset,
  },
  short: {
    width: '30%',
  },
  long: {
    width: '82%',
    marginTop: spacing.md,
  },
  medium: {
    width: '55%',
    marginTop: spacing.sm,
  },
});
