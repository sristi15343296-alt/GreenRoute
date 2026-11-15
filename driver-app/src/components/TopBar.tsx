/**
 * The identity bar.
 *
 * This used to be the place screen names lived, which put a heading inside a
 * 30px corner curve with 8px of padding — it hugged the curve and truncated.
 * Now it carries identity only: a call-sign chip, availability, and one action.
 * Screen names belong to the content (see `PageHead`).
 *
 * The leading chip is always present, so no text ever starts in the curve.
 */

import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { copy } from '../copy';
import { colors, radius, size, spacing, type as typeScale, weight } from '../theme';
import type { Availability } from '../store';
import { GlassSurface } from './Glass';
import { Icon } from './Icon';

interface TopBarProps {
  /** The call sign. Never a screen name. */
  title: string;
  caption?: string | null;
  /** Drives the dot beside the call sign. */
  tone?: Availability;
  onBack?: (() => void) | null;
  actions?: ReactNode;
}

const TONE_COLOR: Record<Availability, string> = {
  available: colors.accent,
  break: colors.warning,
  off: colors.disabled,
};

export function availabilityLabel(availability: Availability): string {
  if (availability === 'break') {
    return copy.availBreak;
  }
  if (availability === 'off') {
    return copy.availOff;
  }
  return copy.availAvailable;
}

export function TopBar({
  title,
  caption,
  tone = 'available',
  onBack,
  actions,
}: TopBarProps): React.JSX.Element {
  return (
    <GlassSurface corner={radius.xxl} style={styles.bar}>
      <View style={styles.row}>
        {onBack === undefined || onBack === null ? null : (
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={4}
            onPress={onBack}
            style={styles.iconButton}
          >
            <Icon color={colors.text} name="chevronLeft" size={20} />
          </Pressable>
        )}

        <View style={styles.chip}>
          <View style={[styles.dot, { backgroundColor: TONE_COLOR[tone] }]} />
          <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={styles.chipText}>
            {title}
          </Text>
        </View>

        {caption === undefined || caption === null || caption.length === 0 ? (
          <View style={styles.grow} />
        ) : (
          <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={styles.caption}>
            {caption}
          </Text>
        )}

        {actions === undefined ? null : <View style={styles.actions}>{actions}</View>}
      </View>
    </GlassSurface>
  );
}

interface TopBarActionProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  icon?: 'clock' | 'alert' | 'gear' | 'layers' | 'nav' | 'user';
  badge?: number;
}

/** A compact action inside the bar. Always has an accessible label. */
export function TopBarAction({
  label,
  onPress,
  disabled = false,
  icon,
  badge,
}: TopBarActionProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={badge === undefined ? label : `${label}, ${badge}`}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={styles.iconButton}
    >
      <Icon color={disabled ? colors.disabled : colors.text} name={icon ?? 'gear'} size={20} />
      {badge === undefined || badge <= 0 ? null : (
        <View style={styles.badge}>
          <Text maxFontSizeMultiplier={1.1} style={styles.badgeText}>
            {badge}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    width: '100%',
    minHeight: size.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 0,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(201,249,76,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(201,249,76,0.32)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  chipText: {
    color: colors.accent,
    fontSize: typeScale.meta,
    fontWeight: weight.strong,
    letterSpacing: 0.3,
  },
  caption: {
    flex: 1,
    minWidth: 0,
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: weight.medium,
  },
  grow: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconButton: {
    minWidth: size.iconButton,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 4,
    end: 3,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.canvas,
  },
  badgeText: {
    color: colors.onAccent,
    fontSize: 10,
    fontWeight: weight.strong,
  },
});
