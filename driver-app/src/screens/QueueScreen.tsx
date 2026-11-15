import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { MapStage } from '../components/MapStage';
import { PageHead } from '../components/PageHead';
import { Screen } from '../components/Screen';
import { SecondaryButton } from '../components/SecondaryButton';
import { SkeletonRows } from '../components/Skeleton';
import { StatusChip } from '../components/StatusChip';
import { TabDock } from '../components/TabDock';
import { TopBar, availabilityLabel } from '../components/TopBar';
import { copy } from '../copy';
import { formatClock, vehicleTypeLabel } from '../format';
import { useStore } from '../store';
import {
  colors,
  contentMaxWidth,
  pressed,
  priorityTint,
  radius,
  size,
  spacing,
  type as typeScale,
  weight,
} from '../theme';
import type { Status, Trip } from '../types';

function QueueRow({
  trip,
  index,
  onPress,
}: {
  trip: Trip;
  index: number;
  onPress: () => void;
}): React.JSX.Element {
  const tint = priorityTint(trip.priority);
  return (
    <Pressable
      accessibilityLabel={`${index + 1}. ${trip.reference}. ${trip.status_label}. ${trip.origin} to ${trip.destination}. ${trip.priority_label} priority.`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.number}>
        <Text maxFontSizeMultiplier={1.1} style={styles.numberLabel}>
          {index + 1}
        </Text>
      </View>

      <View style={styles.body}>
        <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.destination}>
          {trip.destination}
        </Text>
        <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.route}>
          {trip.origin} · {trip.reference}
        </Text>
        <View style={styles.chipRow}>
          <StatusChip label={trip.status_label} status={trip.status} />
          <View style={[styles.priorityPill, { borderColor: tint }]}>
            <Text maxFontSizeMultiplier={1.2} style={[styles.priorityLabel, { color: tint }]}>
              {trip.priority_label}
            </Text>
          </View>
        </View>
      </View>

      <Icon color={colors.secondary} name="chevronRight" size={18} />
    </Pressable>
  );
}

export function QueueScreen(): React.JSX.Element {
  const store = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Status | null>(null);
  const { loadAssignments } = store;
  const assignments = store.assignments;

  // Chips are derived from what dispatch actually sent, and labelled with its
  // own `status_label`: no invented vocabulary, and no status with no responses.
  const filters = useMemo(() => {
    const seen = new Map<Status, string>();
    for (const entry of assignments ?? []) {
      if (!seen.has(entry.status)) {
        seen.set(entry.status, entry.status_label);
      }
    }
    return Array.from(seen, ([status, label]) => ({ status, label }));
  }, [assignments]);

  // A refresh can remove every response in the filtered status; drop the filter
  // rather than showing an empty list with a chip still lit.
  const activeFilter =
    statusFilter !== null && filters.some((entry) => entry.status === statusFilter)
      ? statusFilter
      : null;

  const visible =
    activeFilter === null
      ? assignments ?? []
      : (assignments ?? []).filter((entry) => entry.status === activeFilter);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  const refreshNow = async (): Promise<void> => {
    setRefreshing(true);
    await loadAssignments();
    setRefreshing(false);
  };

  const refreshAction = (
    <SecondaryButton
      icon="clock"
      label={copy.refresh}
      onPress={() => {
        void refreshNow();
      }}
    />
  );

  return (
    <Screen
      busy={refreshing}
      footer={
        <TabDock
          active="queue"
          onSelect={(tab) => {
            store.switchTab({ name: tab });
          }}
        />
      }
      map={
        <MapStage
          mode="pins"
          offline={store.offline}
          onSelectTrip={(tripId) => store.push({ name: 'trip', tripId })}
          trip={null}
          trips={visible}
        />
      }
      pill={
        <TopBar
          caption={`${availabilityLabel(store.availability)} · ${vehicleTypeLabel(
            store.vehicleType
          )}`}
          title={store.callSign ?? 'Unit'}
          tone={store.availability}
        />
      }
    >
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
          {/* The heading sits on its own panel: over live tiles, plain text at
              this size has nothing to separate it from the map. */}
          <View style={styles.panel}>
            <PageHead
              subtitle={
                assignments === null
                  ? undefined
                  : `${assignments.length} open · this unit`
              }
              title={copy.queue}
            />

            <View style={[styles.avail, store.onBreak && styles.availBreak]}>
            <View
              style={[
                styles.availDot,
                store.onBreak && { backgroundColor: colors.warning },
              ]}
            />
            <View style={styles.availBody}>
              <Text maxFontSizeMultiplier={1.2} style={styles.availLabel}>
                {availabilityLabel(store.availability)}
              </Text>
              <Text maxFontSizeMultiplier={1.2} style={styles.availMeta}>
                {store.onBreak
                  ? 'Still receives assignments'
                  : store.shift === null
                    ? 'Not on shift'
                      : `since ${formatClock(new Date(store.shift.startedAt)) ?? '—'}`}
                </Text>
              </View>
            </View>
          </View>

          {filters.length > 1 ? (
            // A wrapping row, not a nested ScrollView: a horizontal ScrollView
            // inside the vertical one stretched to fill the column and turned
            // each chip into a full-height capsule over the map.
            <View style={styles.chips}>
              {filters.map((filter) => {
                const active = activeFilter === filter.status;
                return (
                  <Pressable
                    accessibilityLabel={filter.label}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    hitSlop={8}
                    key={filter.status}
                    onPress={() => setStatusFilter(active ? null : filter.status)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text
                      maxFontSizeMultiplier={1.2}
                      style={[styles.chipLabel, active && styles.chipLabelActive]}
                    >
                      {filter.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {assignments === null ? (
            store.offline ? (
              <EmptyState action={refreshAction} title={copy.networkError} />
            ) : (
              <SkeletonRows />
            )
          ) : assignments.length === 0 ? (
            <EmptyState action={refreshAction} title={copy.noOtherResponses} />
          ) : (
            visible.map((trip, index) => (
              <View key={trip.id} style={index > 0 ? styles.spaced : undefined}>
                <QueueRow
                  index={index}
                  onPress={() => store.push({ name: 'trip', tripId: trip.id })}
                  trip={trip}
                />
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  panel: {
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 12,
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: 'rgba(11,12,11,0.94)',
  },
  avail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: 'rgba(20,22,20,0.86)',
  },
  availBreak: {
    borderColor: 'rgba(255,196,102,0.34)',
  },
  availDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  availBody: {
    flex: 1,
    minWidth: 0,
  },
  availLabel: {
    color: colors.text,
    fontSize: typeScale.secondary,
    fontWeight: weight.medium,
  },
  availMeta: {
    color: colors.secondary,
    fontSize: 12,
    marginTop: 1,
  },
  column: {
    flexGrow: 1,
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
    // The list is a sheet: it anchors to the bottom edge so the map and its
    // numbered pins stay visible above it. An empty state still centres itself
    // because it carries flex:1.
    justifyContent: 'flex-end',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    minHeight: 48,
    shadowColor: '#000000',
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  rowPressed: {
    backgroundColor: pressed,
    borderColor: colors.border,
  },
  number: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(201,249,76,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(201,249,76,0.4)',
  },
  numberLabel: {
    color: colors.accent,
    fontSize: typeScale.meta,
    fontWeight: weight.strong,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  destination: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 22,
    fontWeight: weight.strong,
  },
  route: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 20,
    marginTop: 2,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  priorityPill: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  priorityLabel: {
    fontSize: typeScale.meta,
    lineHeight: 19,
    fontWeight: weight.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  spaced: {
    marginTop: spacing.md,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  chip: {
    minHeight: size.chip,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipLabel: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 20,
    fontWeight: weight.medium,
  },
  chipLabelActive: {
    color: colors.onAccent,
  },
});
