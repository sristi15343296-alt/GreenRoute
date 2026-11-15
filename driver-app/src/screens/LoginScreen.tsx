/**
 * Sign in.
 *
 * Two fields the crew already knows — the call sign on the vehicle and a
 * four-digit PIN — instead of a wall of code. The call sign becomes the unit
 * code dispatch issued; the PIN becomes this device's unlock code, and is never
 * sent anywhere.
 */

import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { apiBaseHost } from '../api';
import { GlassSurface } from '../components/Glass';
import { Icon } from '../components/Icon';
import { PrimaryAction } from '../components/PrimaryAction';
import { copy } from '../copy';
import { isValidCallSign, isValidPin, unitCodeFor } from '../credentials';
import { useStore } from '../store';
import {
  aura,
  colors,
  contentMaxWidth,
  radius,
  spacing,
  type as typeScale,
  weight,
} from '../theme';

export function LoginScreen(): React.JSX.Element {
  const store = useStore();
  const insets = useSafeAreaInsets();
  const [callSign, setCallSign] = useState('');
  const [pin, setPin] = useState('');
  const [remember, setRemember] = useState(true);
  const [message, setMessage] = useState<string | null>(store.pairNotice);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    if (submitting) {
      return;
    }
    if (!isValidCallSign(callSign)) {
      setMessage(copy.callSignInvalid);
      return;
    }
    if (!isValidPin(pin)) {
      setMessage(copy.pinInvalid);
      return;
    }
    setSubmitting(true);
    setMessage(null);
    // Demo dispatch issues `token-med12` for the vehicle the crew calls MED-12;
    // a dispatcher that hands out its own codes is served by the second try.
    let result = await store.pair(unitCodeFor(callSign));
    if (!result.ok) {
      result = await store.pair(callSign.trim());
    }
    if (result.ok) {
      if (remember) {
        await store.setPin(pin);
      }
      setSubmitting(false);
      return;
    }
    // The PIN is cleared, never the call sign: retyping the vehicle is worse
    // than retyping four digits.
    setPin('');
    setMessage(result.message);
    setSubmitting(false);
  };

  return (
    <View style={styles.root}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.auraAccent} />
        <View style={styles.auraCool} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingTop: insets.top + spacing.xl, paddingBottom: spacing.xl },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.column}>
            <View style={styles.brandRow}>
              <View style={styles.logo}>
                <Icon color={colors.onAccent} name="ambulance" size={26} />
              </View>
              <View>
                <Text maxFontSizeMultiplier={1.2} style={styles.brand}>
                  GreenRoute
                </Text>
                <Text maxFontSizeMultiplier={1.2} style={styles.brandTag}>
                  DRIVER
                </Text>
              </View>
            </View>

            <Text maxFontSizeMultiplier={1.2} style={styles.heading}>
              {copy.signInHeading}
            </Text>
            <Text maxFontSizeMultiplier={1.3} style={styles.paragraph}>
              {copy.signInBody}
            </Text>

            <Text maxFontSizeMultiplier={1.2} style={styles.label}>
              {copy.callSignLabel}
            </Text>
            <TextInput
              accessibilityLabel={copy.callSignLabel}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect={false}
              maxLength={12}
              onChangeText={(next) => {
                setCallSign(next.toUpperCase());
                setMessage(null);
              }}
              placeholder={copy.callSignPlaceholder}
              placeholderTextColor={colors.disabled}
              returnKeyType="next"
              style={styles.input}
              value={callSign}
            />

            <Text maxFontSizeMultiplier={1.2} style={[styles.label, styles.labelSpaced]}>
              {copy.pinLabel}
            </Text>
            <TextInput
              accessibilityLabel={copy.pinLabel}
              keyboardType="number-pad"
              maxLength={4}
              onChangeText={(next) => {
                setPin(next.replace(/[^0-9]/g, ''));
                setMessage(null);
              }}
              onSubmitEditing={() => {
                void submit();
              }}
              placeholder={copy.pinPlaceholder}
              placeholderTextColor={colors.disabled}
              returnKeyType="go"
              secureTextEntry
              style={[styles.input, styles.pin]}
              value={pin}
            />

            <Pressable
              accessibilityLabel={copy.rememberUnit}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: remember }}
              onPress={() => setRemember(!remember)}
              style={styles.remember}
            >
              <View style={[styles.checkbox, remember && styles.checkboxOn]}>
                {remember ? <Icon color={colors.onAccent} name="check" size={14} /> : null}
              </View>
              <Text maxFontSizeMultiplier={1.3} style={styles.rememberLabel}>
                {copy.rememberUnit}
              </Text>
            </Pressable>

            {message === null ? null : (
              <Text accessibilityRole="alert" maxFontSizeMultiplier={1.3} style={styles.error}>
                {message}
              </Text>
            )}

            <GlassSurface corner={radius.lg} style={styles.demoChip}>
              <View style={styles.demoRow}>
                <Icon color={colors.warning} name="shield" size={15} />
                <Text maxFontSizeMultiplier={1.2} style={styles.demoText}>
                  Demo dispatch · {apiBaseHost()}
                </Text>
              </View>
            </GlassSurface>
          </View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.column}>
            <PrimaryAction
              disabled={!isValidCallSign(callSign) || !isValidPin(pin)}
              icon="chevronRight"
              label={copy.signIn}
              onPress={() => {
                void submit();
              }}
              pending={submitting}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  body: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
  },
  column: {
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  logo: {
    width: 60,
    height: 60,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brand: {
    color: colors.text,
    fontSize: typeScale.body,
    lineHeight: 25,
    fontWeight: weight.strong,
    letterSpacing: -0.2,
  },
  brandTag: {
    color: colors.secondary,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: weight.medium,
    letterSpacing: 2.2,
  },
  heading: {
    color: colors.text,
    fontSize: typeScale.hero,
    lineHeight: 40,
    fontWeight: weight.medium,
    letterSpacing: -0.8,
    marginTop: spacing.xl,
  },
  paragraph: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 22,
    marginTop: spacing.sm,
  },
  label: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: weight.medium,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  labelSpaced: {
    marginTop: spacing.lg,
  },
  input: {
    minHeight: 58,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.rim,
    backgroundColor: 'rgba(15,17,15,0.72)',
    color: colors.text,
    fontSize: typeScale.body,
    paddingHorizontal: spacing.lg,
    fontVariant: ['tabular-nums'],
  },
  pin: {
    letterSpacing: 6,
  },
  remember: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    marginTop: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.xs + 1,
    borderWidth: 1,
    borderColor: colors.rim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  rememberLabel: {
    color: colors.secondary,
    fontSize: typeScale.meta,
  },
  error: {
    color: colors.danger,
    fontSize: typeScale.meta,
    lineHeight: 21,
    marginTop: spacing.sm,
  },
  demoChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.xl,
  },
  demoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  demoText: {
    color: colors.warning,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: weight.medium,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  auraAccent: {
    position: 'absolute',
    width: 540,
    height: 540,
    borderRadius: 270,
    start: -180,
    top: -160,
    backgroundColor: aura.accent,
  },
  auraCool: {
    position: 'absolute',
    width: 480,
    height: 480,
    borderRadius: 240,
    end: -170,
    bottom: 30,
    backgroundColor: aura.cool,
  },
});
