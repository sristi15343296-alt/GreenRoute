import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AssignmentFooter } from '../components/AssignmentFooter';
import { EmptyState } from '../components/EmptyState';
import { MapStage } from '../components/MapStage';
import { Screen } from '../components/Screen';
import { SecondaryButton } from '../components/SecondaryButton';
import { Timeline } from '../components/Timeline';
import { TopBar } from '../components/TopBar';
import { TripSummary } from '../components/TripSummary';
import { copy } from '../copy';
import { useStore } from '../store';
import { colors, contentMaxWidth, radius, spacing, type as typeScale, weight } from '../theme';
import { primaryAction } from '../types';

export function TripScreen({ tripId }: { tripId: number }): React.JSX.Element {
  const store = useStore();
  const [missing, setMissing] = useState(false);
  const { loadTrip, pop } = store;

  useEffect(() => {
    let cancelled = false;
    setMissing(false);
    void loadTrip(tripId).then((loaded) => {
      if (!cancelled && loaded === null) {
        setMissing(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tripId, loadTrip]);

  const trip = store.trips[tripId] ?? null;
  const pending = trip !== null && store.isPending(trip.id);
  const unconfirmed =
    trip !== null && store.outbox.some((item) => item.tripId === trip.id && item.attempts > 0);

  return (
    <Screen
      footer={
        trip !== null && primaryAction(trip) !== null ? (
          <AssignmentFooter trip={trip} />
        ) : undefined
      }
      map={<MapStage offline={store.offline} trip={trip} />}
      pill={
        <TopBar
          caption={trip === null ? null : `${trip.reference} · ${trip.status_label}`}
          onBack={pop}
          title={store.callSign ?? 'Unit'}
          tone={store.availability}
        />
      }
    >
      {trip === null ? (
        missing ? (
          <EmptyState
            action={<SecondaryButton icon="chevronLeft" label={copy.back} onPress={pop} />}
            title={copy.tripGone}
          />
        ) : (
          <View style={styles.loading}>
            <Text maxFontSizeMultiplier={1.3} style={styles.loadingText}>
              {copy.contactingDispatch}
            </Text>
          </View>
        )
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.column}>
            <TripSummary pending={pending} trip={trip} unconfirmed={unconfirmed} />

            {trip.instructions === null || trip.instructions.trim().length === 0 ? null : (
              <View style={styles.section}>
                <Text maxFontSizeMultiplier={1.3} style={styles.sectionTitle}>
                  {copy.instructions}
                </Text>
                <View style={styles.panel}>
                  <Text maxFontSizeMultiplier={1.3} style={styles.instructions}>
                    {trip.instructions}
                  </Text>
                </View>
              </View>
            )}

            <View style={styles.section}>
              <Text maxFontSizeMultiplier={1.3} style={styles.sectionTitle}>
                {copy.timeline}
              </Text>
              <View style={styles.panel}>
                <Timeline events={trip.timeline} />
              </View>
            </View>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    // The dock floats over the list, so the last row must clear it.
    paddingBottom: 190,
  },
  column: {
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  loadingText: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    textAlign: 'center',
  },
  section: {
    marginTop: spacing.xl,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: typeScale.section,
    lineHeight: 30,
    fontWeight: weight.medium,
    letterSpacing: -0.2,
    marginBottom: spacing.sm,
  },
  panel: {
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  instructions: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 26,
  },
});
