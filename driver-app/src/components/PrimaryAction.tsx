/**
 * The single primary action: filled accent, 58 tall, bottom of the screen.
 * The label keeps its size in every state and the spinner slot is reserved, so
 * nothing shifts under the driver's thumb.
 */

import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { useReduceMotion } from '../a11y';
import {
  accentGradient,
  colors,
  motion,
  radius,
  size,
  type as typeScale,
  weight,
} from '../theme';
import { Icon, type IconName } from './Icon';

interface PrimaryActionProps {
  label: string;
  onPress: () => void;
  pending?: boolean;
  disabled?: boolean;
  icon?: IconName;
}

export function PrimaryAction({
  label,
  onPress,
  pending = false,
  disabled = false,
  icon = 'check',
}: PrimaryActionProps): React.JSX.Element {
  const scale = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReduceMotion();
  const inactive = pending || disabled;

  const animate = (toValue: number): void => {
    Animated.timing(scale, {
      toValue,
      duration: reduceMotion ? 0 : motion.press,
      useNativeDriver: true,
    }).start();
  };

  const handlePress = (): void => {
    if (inactive) {
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Animated.View style={[{ transform: [{ scale }] }, inactive ? null : styles.lift]}>
      <Pressable
        accessibilityLabel={pending ? `${label}, sending` : label}
        accessibilityRole="button"
        accessibilityState={{ busy: pending, disabled: inactive }}
        disabled={inactive}
        onPress={handlePress}
        onPressIn={() => animate(0.985)}
        onPressOut={() => animate(1)}
        style={[styles.button, inactive && styles.inactive]}
      >
        {inactive ? null : (
          <LinearGradient
            colors={accentGradient}
            end={{ x: 0.5, y: 1 }}
            pointerEvents="none"
            start={{ x: 0.5, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        )}
        <View style={styles.content}>
          <Icon color={inactive ? colors.disabled : colors.onAccent} name={icon} size={22} />
          <Text
            maxFontSizeMultiplier={1.3}
            style={[styles.label, inactive && styles.labelInactive]}
          >
            {label}
          </Text>
          <View style={styles.spinnerSlot}>
            {pending ? <ActivityIndicator color={colors.onAccent} size="small" /> : null}
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: size.primary,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    overflow: 'hidden',
  },
  lift: {
    shadowColor: colors.accent,
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  inactive: {
    backgroundColor: colors.inset,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  label: {
    color: colors.onAccent,
    fontSize: typeScale.body,
    lineHeight: 24,
    fontWeight: weight.strong,
  },
  labelInactive: {
    color: colors.disabled,
  },
  spinnerSlot: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
