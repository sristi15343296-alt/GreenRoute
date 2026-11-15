import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from './src/components/Glass';
import { ChecklistScreen } from './src/screens/ChecklistScreen';
import { DutyScreen } from './src/screens/DutyScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { LockScreen } from './src/screens/LockScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { QueueScreen } from './src/screens/QueueScreen';
import { TripScreen } from './src/screens/TripScreen';
import { StoreProvider, useStore } from './src/store';
import { colors, contentMaxWidth, radius, spacing, type as typeScale } from './src/theme';

/** Sits above the primary action, never over it, and never stacks. */
function NoticeToast(): React.JSX.Element | null {
  const store = useStore();
  const insets = useSafeAreaInsets();
  if (store.notice === null) {
    return null;
  }
  return (
    <View pointerEvents="none" style={[styles.toastWrap, { bottom: insets.bottom + 148 }]}>
      <GlassSurface corner={radius.lg} shadow="toast" style={styles.toast}>
        <Text
          accessibilityLiveRegion="polite"
          maxFontSizeMultiplier={1.3}
          style={[styles.toastText, store.notice.tone === 'error' && styles.toastTextError]}
        >
          {store.notice.text}
        </Text>
      </GlassSurface>
    </View>
  );
}

function Root(): React.JSX.Element {
  const store = useStore();
  const depth = store.stack.length;
  const { pop } = store;

  // Sheet → Trip → Home → background. Back never exits from Trip.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (depth > 1) {
        pop();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [depth, pop]);

  if (!store.ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (store.token === null) {
    return <LoginScreen />;
  }

  if (store.locked) {
    return <LockScreen />;
  }

  const route = store.route;

  return (
    <View style={styles.root}>
      {route.name === 'home' ? <HomeScreen /> : null}
      {route.name === 'queue' ? <QueueScreen /> : null}
      {route.name === 'trip' ? <TripScreen tripId={route.tripId} /> : null}
      {route.name === 'history' ? <HistoryScreen /> : null}
      {route.name === 'profile' ? <ProfileScreen /> : null}
      {route.name === 'duty' ? <DutyScreen /> : null}
      {route.name === 'checklist' ? <ChecklistScreen /> : null}
      <NoticeToast />
    </View>
  );
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <StatusBar style="light" />
        <Root />
      </StoreProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.canvas,
  },
  toastWrap: {
    position: 'absolute',
    start: spacing.lg,
    end: spacing.lg,
    alignItems: 'center',
  },
  toast: {
    width: '100%',
    maxWidth: contentMaxWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  toastText: {
    color: colors.text,
    fontSize: typeScale.meta,
    lineHeight: 21,
  },
  toastTextError: {
    color: colors.danger,
  },
});
