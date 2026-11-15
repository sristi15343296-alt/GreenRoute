/**
 * A secondary action in the dock: icon above label, 52 tall, never filled.
 * Three of these sit under the primary action, inside the thumb band.
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, radius, size, spacing, type as typeScale, weight } from '../theme';
import { Icon, type IconName } from './Icon';

interface SecondaryButtonProps {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
}

export function SecondaryButton({
  label,
  icon,
  onPress,
  disabled = false,
}: SecondaryButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && !disabled && styles.pressed]}
    >
      <Icon color={disabled ? colors.disabled : colors.secondary} name={icon} size={19} />
      <Text
        maxFontSizeMultiplier={1.3}
        numberOfLines={2}
        style={[styles.label, disabled && styles.labelDisabled]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    minWidth: size.target,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: spacing.xs,
    paddingVertical: 6,
    borderRadius: radius.md,
  },
  pressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  label: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 18,
    fontWeight: weight.medium,
    textAlign: 'center',
  },
  labelDisabled: {
    color: colors.disabled,
  },
});
