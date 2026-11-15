/**
 * The lock, shown when a PIN was stored for this unit.
 *
 * Without this the PIN on the sign-in screen would be decoration: a stored unit
 * token opens the whole app. Fingerprint is offered when the device has an
 * enrolled sensor, and hidden when it does not — a button that always fails is
 * worse than no button.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import React, { useEffect, useState } from 'react';
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

import { Icon } from '../components/Icon';
import { PrimaryAction } from '../components/PrimaryAction';
import { copy } from '../copy';
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

export function LockScreen(): React.JSX.Element {
  const store = useStore();
  const insets = useSafeAreaInsets();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [biometrics, setBiometrics] = useState(false);

  const { unlock, unlockWithBiometrics, unpair } = store;

  const tryBiometrics = async (): Promise<void> => {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: copy.lockedTitle,
        cancelLabel: copy.cancel,
        disableDeviceFallback: true,
      });
      if (result.success) {
        // The OS verified the driver, so the local lock opens. The stored PIN is
        // untouched and is still what the next cold start asks for.
        setPin('');
        unlockWithBiometrics();
      }
    } catch {
      // Sensor refused or unavailable: the PIN field is still there.
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [hardware, enrolled] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!cancelled) {
          setBiometrics(hardware && enrolled);
        }
      } catch {
        if (!cancelled) {
          setBiometrics(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    const ok = await unlock(pin);
    setBusy(false);
    if (!ok) {
      setPin('');
      setMessage(copy.wrongPin);
    }
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
            { paddingTop: insets.top + spacing.xxl, paddingBottom: spacing.xl },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.column}>
            <View style={styles.logo}>
              <Icon color={colors.accent} name="shield" size={26} />
            </View>
            <Text maxFontSizeMultiplier={1.3} style={styles.heading}>
              {copy.lockedTitle}
            </Text>
            <Text maxFontSizeMultiplier={1.3} style={styles.paragraph}>
              {copy.lockedBody}
            </Text>

            <TextInput
              accessibilityLabel={copy.pinLabel}
              autoFocus
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
              secureTextEntry
              style={styles.input}
              value={pin}
            />

            {message === null ? null : (
              <Text accessibilityRole="alert" maxFontSizeMultiplier={1.3} style={styles.error}>
                {message}
              </Text>
            )}

            {biometrics ? (
              <Pressable
                accessibilityLabel={copy.unlockFingerprint}
                accessibilityRole="button"
                onPress={() => {
                  void tryBiometrics();
                }}
                style={({ pressed }) => [styles.biometric, pressed && styles.biometricPressed]}
              >
                <Icon color={colors.secondary} name="fingerprint" size={20} />
                <Text maxFontSizeMultiplier={1.3} style={styles.biometricLabel}>
                  {copy.unlockFingerprint}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              accessibilityLabel={copy.signOut}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                void unpair();
              }}
              style={styles.signOut}
            >
              <Text maxFontSizeMultiplier={1.3} style={styles.signOutLabel}>
                {copy.signOut}
              </Text>
            </Pressable>
          </View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.column}>
            <PrimaryAction
              disabled={pin.length !== 4}
              icon="chevronRight"
              label={copy.signIn}
              onPress={() => {
                void submit();
              }}
              pending={busy}
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
  logo: {
    width: 60,
    height: 60,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.rim,
    alignItems: 'center',
    justifyContent: 'center',
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
    fontSize: typeScale.secondary,
    lineHeight: 24,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  input: {
    minHeight: 64,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.rim,
    backgroundColor: 'rgba(15,17,15,0.72)',
    color: colors.text,
    fontSize: typeScale.section,
    letterSpacing: 10,
    paddingHorizontal: spacing.lg,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  error: {
    color: colors.danger,
    fontSize: typeScale.meta,
    lineHeight: 21,
    marginTop: spacing.sm,
  },
  biometric: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 54,
    marginTop: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  biometricPressed: {
    backgroundColor: colors.raised,
  },
  biometricLabel: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    fontWeight: weight.medium,
  },
  signOut: {
    alignSelf: 'center',
    minHeight: 48,
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  signOutLabel: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    textDecorationLine: 'underline',
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
    top: -200,
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
