import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, { useEffect, useState } from 'react';
import { AppState, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActivitySheet } from '../components/ActivitySheet';
import { EmptyState } from '../components/EmptyState';
import { MapStage } from '../components/MapStage';
import { OfflineBanner } from '../components/OfflineBanner';
import { Screen } from '../components/Screen';
import { SecondaryButton } from '../components/SecondaryButton';
import { TabDock } from '../components/TabDock';
import { TelemetryBadge } from '../components/TelemetryBadge';
import { TopBar, TopBarAction, availabilityLabel } from '../components/TopBar';
import { TripSheet, type SheetSnap } from '../components/TripSheet';
import { copy } from '../copy';
import { formatServerClock, vehicleTypeLabel } from '../format';
import { useStore } from '../store';
import { colors, contentMaxWidth, spacing, type as typeScale } from '../theme';

const KEEP_AWAKE_TAG = 'greenroute-home';

export function HomeScreen(): React.JSX.Element {
  const store = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [snap, setSnap] = useState<SheetSnap>('peek');
  const [sheetHeight, setSheetHeight] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const trip = store.assignment;
  const hasAssignment = trip !== null;

  // The screen stays awake only while Home is foregrounded with a live assignment.
  useEffect(() => {
    if (!hasAssignment) {
      return;
    }
    let foreground = AppState.currentState === 'active';
    const sync = (): void => {
      if (foreground) {
        void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      } else {
        deactivateKeepAwake(KEEP_AWAKE_TAG);
      }
    };
    sync();
    const subscription = AppState.addEventListener('change', (next) => {
      foreground = next === 'active';
      sync();
    });
    return () => {
      subscription.remove();
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [hasAssignment]);

  const refreshNow = async (): Promise<void> => {
    setRefreshing(true);
    await store.refresh();
    setRefreshing(false);
  };

  // The badge measures itself against the app's single clock, so it refreshes
  // once a second without a timer of its own.
  const telemetryAgeMs =
    store.telemetry.lastFixAt === null
      ? null
      : Math.max(0, store.nowMs - store.telemetry.lastFixAt);

  const pending = trip !== null && store.isPending(trip.id);
  const unconfirmed =
    trip !== null && store.outbox.some((item) => item.tripId === trip.id && item.attempts > 0);

  // Fully open, the details are the app. The identity pill and the dock get out
  // of the way rather than floating over a list the driver is reading.
  const parked = trip !== null && snap === 'full';

  return (
    <Screen
      busy={refreshing}
      contentBottom={spacing.lg}
      footer={
        parked ? undefined : (
          <TabDock
            active="home"
            onSelect={(tab) => {
              store.switchTab({ name: tab });
            }}
          />
        )
      }
      footerOffset={trip === null ? undefined : sheetHeight}
      map={
        <MapStage
          // The camera frames the route above the sheet *and* above the dock
          // floating over it, otherwise the destination hides behind the dock
          // as soon as the sheet is opened.
          bottomInset={trip === null ? 0 : sheetHeight + (parked ? 0 : 96)}
          offline={store.offline}
          trip={trip}
        />
      }
      pill={
        parked ? undefined : (
          <TopBar
            actions={
              <TopBarAction
                badge={store.outbox.length}
                icon="clock"
                label={copy.activityTitle}
                onPress={() => setActivityOpen(true)}
              />
            }
            caption={`${availabilityLabel(store.availability)} · ${vehicleTypeLabel(
              store.vehicleType
            )}`}
            title={store.callSign ?? 'Unit'}
            tone={store.availability}
          />
        )
      }
      sheet={
        trip === null ? undefined : (
          <TripSheet
            banner={
              <View style={styles.banner}>
                <TelemetryBadge ageMs={telemetryAgeMs} telemetry={store.telemetry} />
                {store.offline ? (
                  <View style={styles.bannerGap}>
                    <OfflineBanner
                      lastUpdated={formatServerClock(store.serverTime)}
                      pendingCount={store.pendingCount}
                      unconfirmedCount={store.unconfirmedCount}
                    />
                  </View>
                ) : null}
              </View>
            }
            nowMs={store.nowMs}
            onHeight={setSheetHeight}
            onSnap={setSnap}
            pending={pending}
            snap={snap}
            trip={trip}
            unconfirmed={unconfirmed}
          />
        )
      }
    >
      <ActivitySheet
        onClose={() => setActivityOpen(false)}
        visible={activityOpen}
      />
      {trip !== null ? null : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              colors={[colors.accent]}
              onRefresh={() => {
                void refreshNow();
              }}
              progressBackgroundColor={colors.raised}
              refreshing={refreshing}
              tintColor={colors.accent}
            />
          }
        >
          <View style={styles.column}>
            <View style={styles.banner}>
              <TelemetryBadge ageMs={telemetryAgeMs} telemetry={store.telemetry} />
            </View>

            {store.offline ? (
              <OfflineBanner
                lastUpdated={formatServerClock(store.serverTime)}
                pendingCount={store.pendingCount}
                unconfirmedCount={store.unconfirmedCount}
              />
            ) : null}

            {!store.loaded ? (
              store.offline ? (
                <EmptyState
                  action={
                    <SecondaryButton
                      icon="clock"
                      label={copy.refresh}
                      onPress={() => {
                        void refreshNow();
                      }}
                    />
                  }
                  title={copy.networkError}
                />
              ) : (
                <Text maxFontSizeMultiplier={1.3} style={styles.contacting}>
                  {copy.contactingDispatch}
                </Text>
              )
            ) : (
              <EmptyState
                action={
                  <SecondaryButton
                    icon="clock"
                    label={copy.refresh}
                    onPress={() => {
                      void refreshNow();
                    }}
                  />
                }
                title={copy.noActiveAssignment}
              />
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  column: {
    flexGrow: 1,
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
  },
  banner: {
    marginBottom: spacing.md,
  },
  bannerGap: {
    marginTop: spacing.sm,
  },
  contacting: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    marginTop: spacing.lg,
  },
});
