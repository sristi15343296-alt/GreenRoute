/**
 * One compact banner while the last request to dispatch failed. It reports the
 * pending count and whether those items were ever sent.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { copy } from '../copy';
import { colors, radius, spacing, type as typeScale } from '../theme';
import { Icon } from './Icon';

interface OfflineBannerProps {
  pendingCount: number;
  unconfirmedCount: number;
  lastUpdated: string | null;
}

export function OfflineBanner({
  pendingCount,
  unconfirmedCount,
  lastUpdated,
}: OfflineBannerProps): React.JSX.Element {
  const parts: string[] = [copy.noConnection];
  if (pendingCount > 0) {
    parts.push(
      `${pendingCount} pending · ${
        unconfirmedCount > 0 ? copy.deliveryUnconfirmed : copy.notSentYet
      }`
    );
  }
  if (lastUpdated !== null) {
    parts.push(`${copy.lastUpdated} ${lastUpdated}`);
  }

  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <Icon color={colors.warning} name="alert" size={16} />
      <Text maxFontSizeMultiplier={1.3} style={styles.text}>
        {parts.join(' · ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warningSurface,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  text: {
    color: colors.warning,
    fontSize: typeScale.meta,
    lineHeight: 20,
    marginStart: spacing.sm,
    flexShrink: 1,
  },
});
