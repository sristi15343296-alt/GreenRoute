/**
 * The pending overlay. The chip stays truthful; this pill says the update is on
 * its way, and whether an earlier attempt already left the device.
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { copy } from '../copy';
import { colors, radius, spacing, type as typeScale, weight } from '../theme';

export function SendingPill({ unconfirmed }: { unconfirmed: boolean }): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={unconfirmed ? copy.sendingRetry : copy.sending}
      style={styles.pill}
    >
      <ActivityIndicator color={colors.secondary} size="small" />
      <Text maxFontSizeMultiplier={1.3} style={styles.label}>
        {unconfirmed ? copy.sendingRetry : copy.sending}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 30,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.inset,
  },
  label: {
    marginStart: spacing.sm,
    color: colors.secondary,
    fontSize: typeScale.meta,
    fontWeight: weight.medium,
  },
});
