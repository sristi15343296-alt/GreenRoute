/**
 * History: what this unit finished, and what dispatch took away.
 *
 * The dispatch API keeps no history endpoint, so the rows come from the demo
 * module and are labelled as such. Live responses this session are shown first
 * when the server has sent any.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EmptyState } from '../components/EmptyState';
import { PageHead } from '../components/PageHead';
import { Screen } from '../components/Screen';
import { TabDock } from '../components/TabDock';
import { TopBar, availabilityLabel } from '../components/TopBar';
import { copy } from '../copy';
import { DEMO_HISTORY, type HistoryEntry } from '../demo';
import { useStore } from '../store';
import { vehicleTypeLabel } from '../format';
import {
  colors,
  contentMaxWidth,
  radius,
  size,
  spacing,
  tabular,
  type as typeScale,
  weight,
} from '../theme';

type Filter = 'all' | 'done' | 'cancelled';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'done', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const DAY_LABELS: Record<HistoryEntry['day'], string> = {
  today: copy.today,
  yesterday: copy.yesterday,
  earlier: copy.earlier,
};

function Row({ entry }: { entry: HistoryEntry }): React.JSX.Element {
  const done = entry.outcome === 'done';
  return (
    <View
      accessible
      accessibilityLabel={`${entry.reference}. ${entry.destination}. ${
        done ? 'Completed' : 'Cancelled'
      }. ${entry.window}.`}
      style={styles.row}
    >
      <View style={[styles.duration, done ? styles.durationDone : styles.durationCancelled]}>
        <Text
          maxFontSizeMultiplier={1.2}
          style={[styles.durationLabel, done ? styles.durationLabelDone : styles.durationLabelOff]}
        >
          {entry.durationLabel}
        </Text>
      </View>
      <View style={styles.body}>
        <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.destination}>
          {entry.destination}
        </Text>
        <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={[styles.meta, tabular]}>
          {entry.reference} · {entry.window}
        </Text>
      </View>
      <View
        style={[
          styles.outcome,
          done ? styles.outcomeDone : styles.outcomeCancelled,
        ]}
      >
        <Text
          maxFontSizeMultiplier={1.2}
          style={[styles.outcomeLabel, done ? styles.outcomeTextDone : styles.outcomeTextOff]}
        >
          {done ? 'Done' : 'Cancelled'}
        </Text>
      </View>
    </View>
  );
}

export function HistoryScreen(): React.JSX.Element {
  const store = useStore();
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(
    () => DEMO_HISTORY.filter((entry) => filter === 'all' || entry.outcome === filter),
    [filter]
  );

  const groups = useMemo(() => {
    const order: HistoryEntry['day'][] = ['today', 'yesterday', 'earlier'];
    return order
      .map((day) => ({ day, entries: visible.filter((entry) => entry.day === day) }))
      .filter((group) => group.entries.length > 0);
  }, [visible]);

  const todayCount = visible.filter((entry) => entry.day === 'today').length;

  return (
    <Screen
      aura
      footer={
        <TabDock
          active="history"
          onSelect={(tab) => {
            store.switchTab({ name: tab });
          }}
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
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.column}>
          <PageHead
            subtitle={`${copy.today} · ${todayCount} ${copy.responses} · ${copy.demoData}`}
            title={copy.history}
          />

          <View style={styles.chips}>
            {FILTERS.map((entry) => {
              const active = filter === entry.value;
              return (
                <Pressable
                  accessibilityLabel={entry.label}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  key={entry.value}
                  onPress={() => setFilter(entry.value)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text
                    maxFontSizeMultiplier={1.2}
                    style={[styles.chipLabel, active && styles.chipLabelActive]}
                  >
                    {entry.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {groups.length === 0 ? (
            <EmptyState title={copy.noHistory} />
          ) : (
            groups.map((group) => (
              <View key={group.day}>
                <Text maxFontSizeMultiplier={1.2} style={styles.groupLabel}>
                  {DAY_LABELS[group.day]}
                </Text>
                {group.entries.map((entry) => (
                  <View key={entry.id} style={styles.spaced}>
                    <Row entry={entry} />
                  </View>
                ))}
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
    paddingBottom: spacing.xl,
  },
  column: {
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
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
  groupLabel: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: weight.medium,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  duration: {
    minWidth: 58,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  durationDone: {
    backgroundColor: 'rgba(201,249,76,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(201,249,76,0.32)',
  },
  durationCancelled: {
    backgroundColor: colors.inset,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  durationLabel: {
    fontSize: typeScale.meta,
    fontWeight: weight.strong,
    fontVariant: ['tabular-nums'],
  },
  durationLabelDone: {
    color: colors.accent,
  },
  durationLabelOff: {
    color: colors.secondary,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  destination: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 22,
    fontWeight: weight.medium,
  },
  meta: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 19,
    marginTop: 2,
  },
  outcome: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  outcomeDone: {
    borderColor: 'rgba(111,208,140,0.4)',
    backgroundColor: 'rgba(111,208,140,0.12)',
  },
  outcomeCancelled: {
    borderColor: colors.border,
    backgroundColor: colors.inset,
  },
  outcomeLabel: {
    fontSize: 13,
    fontWeight: weight.medium,
  },
  outcomeTextDone: {
    color: '#6fd08c',
  },
  outcomeTextOff: {
    color: colors.secondary,
  },
  spaced: {
    marginTop: spacing.sm,
  },
  demoBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSurface,
  },
  demoBadgeText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: weight.medium,
    letterSpacing: 0.5,
  },
});
