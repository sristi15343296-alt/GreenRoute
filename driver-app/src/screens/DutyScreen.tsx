/**
 * Duty: how long this unit has been on shift, and what it has done.
 *
 * The clock is the store's, not this screen's: it starts when the unit signs in
 * and keeps running while the driver is on Home, in Queue or in a response.
 * Ending the shift shows what the shift was before it clears it.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { PageHead } from '../components/PageHead';
import { Icon } from '../components/Icon';
import { Ring } from '../components/Ring';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { TabDock } from '../components/TabDock';
import { TopBar, availabilityLabel } from '../components/TopBar';
import { copy } from '../copy';
import { formatClock, vehicleTypeLabel } from '../format';
import { useStore } from '../store';
import {
  colors,
  contentMaxWidth,
  radius,
  spacing,
  tabular,
  type as typeScale,
  weight,
} from '../theme';

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** h:mm:ss, so the seconds are visibly moving. */
export function shiftClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(
    seconds % 60
  )}`;
}

/** h:mm, for a total you read rather than watch. */
function shortClock(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

function Stat({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <View style={styles.stat}>
      <Text maxFontSizeMultiplier={1.2} style={[styles.statValue, tabular]}>
        {value}
      </Text>
      <Text maxFontSizeMultiplier={1.2} style={styles.statLabel}>
        {label}
      </Text>
    </View>
  );
}

export function DutyScreen(): React.JSX.Element {
  const store = useStore();
  const [summaryOpen, setSummaryOpen] = useState(false);

  // Count what this shift actually closed, not what is still waiting. A trip
  // can be re-emitted by the queue, so ids are deduped.
  const shiftStart = store.shift === null ? null : Date.parse(store.shift.startedAt);
  const responsesThisShift = new Set(
    store.activity
      .filter(
        (entry) =>
          entry.kind === 'action' &&
          entry.ref !== undefined &&
          (shiftStart === null || Date.parse(entry.at) >= shiftStart)
      )
      .map((entry) => entry.ref)
  ).size;
  const km = store.trips
    ? Object.values(store.trips).reduce((total, trip) => total + (trip.distance_km ?? 0), 0)
    : 0;
  // A twelve-hour shift fills the ring, so the arc means something.
  const progress = Math.min(store.elapsedMs / (12 * 60 * 60 * 1000), 1);
  const onBreakFor =
    store.shift?.breakStartedAt === null || store.shift?.breakStartedAt === undefined
      ? 0
      : Math.max(0, store.nowMs - Date.parse(store.shift.breakStartedAt));
  const startedLabel =
    store.shift === null ? '—' : formatClock(new Date(store.shift.startedAt)) ?? '—';

  const copySummary = async (): Promise<void> => {
    const lines = [
      `${store.callSign ?? 'Unit'} shift`,
      `Started ${startedLabel}`,
      `${shortClock(store.elapsedMs)} on duty`,
      `${responsesThisShift} responses`,
      `${km.toFixed(1)} km driven`,
    ];
    await Clipboard.setStringAsync(lines.join('\n'));
    store.showNotice(copy.summaryCopied);
  };

  return (
    <Screen
      aura
      footer={
        <TabDock
          active="profile"
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
          onBack={store.pop}
          title={store.callSign ?? copy.duty}
          tone={store.availability}
        />
      }
    >
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.column}>
          <PageHead
            subtitle={`Shift started ${startedLabel} · ${shortClock(store.elapsedMs)}`}
            title={copy.duty}
          />

          <View style={styles.ringWrap}>
            <Ring progress={progress} size={200} thickness={13} />
            <View pointerEvents="none" style={styles.ringCentre}>
              <Text maxFontSizeMultiplier={1.2} style={styles.ringLabel}>
                {store.onBreak ? copy.availBreak : copy.onDuty}
              </Text>
              <Text maxFontSizeMultiplier={1.2} style={[styles.ringClock, tabular]}>
                {shiftClock(store.elapsedMs)}
              </Text>
            </View>
          </View>

          <Text maxFontSizeMultiplier={1.3} style={styles.available}>
            {availabilityLabel(store.availability)} · {store.callSign ?? '—'}
          </Text>

          <View style={styles.stats}>
            <Stat
              label={`${copy.responses} this shift`}
              value={String(responsesThisShift)}
            />
            <Stat label={copy.kmDriven} value={km.toFixed(1)} />
            <Stat
              label={copy.onBreak}
              value={store.onBreak ? shortClock(onBreakFor) : '—'}
            />
          </View>

          <View style={styles.breakCard}>
            <View style={styles.breakIcon}>
              <Icon color={colors.text} name="pause" size={16} />
            </View>
            <View style={styles.grow}>
              <Text maxFontSizeMultiplier={1.3} style={styles.breakTitle}>
                {store.onBreak ? copy.availBreak : copy.takeBreak}
              </Text>
              <Text maxFontSizeMultiplier={1.2} style={styles.breakMeta}>
                {store.onBreak ? 'Shift clock paused' : 'Pauses the shift clock'}
              </Text>
            </View>
            <Switch
              accessibilityLabel={copy.takeBreak}
              onValueChange={() => {
                void store.toggleBreak();
              }}
              thumbColor={store.onBreak ? colors.accent : undefined}
              trackColor={{ false: 'rgba(255,255,255,0.16)', true: 'rgba(201,249,76,0.4)' }}
              value={store.onBreak}
            />
          </View>

          <Text maxFontSizeMultiplier={1.2} style={styles.sectionLabel}>
            {copy.vehicle}
          </Text>
          <View style={styles.card}>
            <View style={styles.vehicleRow}>
              <View style={styles.vehicleIcon}>
                <Icon color={colors.accent} name="ambulance" size={20} />
              </View>
              <View style={styles.grow}>
                <Text maxFontSizeMultiplier={1.3} style={styles.vehicleName}>
                  {vehicleTypeLabel(store.vehicleType)}
                </Text>
                <Text maxFontSizeMultiplier={1.2} style={styles.vehicleMeta}>
                  {store.callSign ?? '—'} · Unit
                </Text>
              </View>
              <View style={styles.readyPill}>
                <Text maxFontSizeMultiplier={1.1} style={styles.readyLabel}>
                  {copy.ready}
                </Text>
              </View>
            </View>
          </View>

          <Pressable
            accessibilityLabel={copy.endShift}
            accessibilityRole="button"
            onPress={() => setSummaryOpen(true)}
            style={({ pressed }) => [styles.endShift, pressed && styles.endShiftPressed]}
          >
            <Icon color={colors.secondary} name="pause" size={18} />
            <Text maxFontSizeMultiplier={1.3} style={styles.endShiftLabel}>
              {copy.endShift}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      <Sheet
        footer={
          <>
            <Pressable
              accessibilityLabel={copy.endShiftNow}
              accessibilityRole="button"
              onPress={() => {
                setSummaryOpen(false);
                void store.endShift();
                store.switchTab({ name: 'home' });
              }}
              style={({ pressed }) => [styles.confirm, pressed && styles.confirmPressed]}
            >
              <Text maxFontSizeMultiplier={1.2} style={styles.confirmLabel}>
                {copy.endShiftNow}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={copy.cancel}
              accessibilityRole="button"
              onPress={() => setSummaryOpen(false)}
              style={styles.cancel}
            >
              <Text maxFontSizeMultiplier={1.2} style={styles.cancelLabel}>
                {copy.cancel}
              </Text>
            </Pressable>
          </>
        }
        onClose={() => setSummaryOpen(false)}
        title={copy.endShiftTitle}
        visible={summaryOpen}
      >
        <Text maxFontSizeMultiplier={1.3} style={styles.summaryLead}>
          {`${shortClock(store.elapsedMs)} on duty · ${responsesThisShift} responses`}
        </Text>

        <View style={styles.summaryStats}>
          <Stat label={copy.onDuty} value={shortClock(store.elapsedMs)} />
          <Stat label={copy.responses} value={String(responsesThisShift)} />
          <Stat label="km" value={km.toFixed(1)} />
        </View>

        <Pressable
          accessibilityLabel={copy.copySummary}
          accessibilityRole="button"
          onPress={() => {
            void copySummary();
          }}
          style={({ pressed }) => [styles.copyRow, pressed && styles.copyRowPressed]}
        >
          <Icon color={colors.text} name="layers" size={17} />
          <Text maxFontSizeMultiplier={1.2} style={styles.copyLabel}>
            {copy.copySummary}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={copy.viewHistory}
          accessibilityRole="button"
          onPress={() => {
            setSummaryOpen(false);
            store.switchTab({ name: 'history' });
          }}
          style={({ pressed }) => [styles.copyRow, pressed && styles.copyRowPressed]}
        >
          <Icon color={colors.text} name="clock" size={17} />
          <Text maxFontSizeMultiplier={1.2} style={styles.copyLabel}>
            {copy.viewHistory}
          </Text>
        </Pressable>
      </Sheet>
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
  ringWrap: {
    alignSelf: 'center',
    marginTop: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringCentre: {
    position: 'absolute',
    alignItems: 'center',
  },
  ringLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: weight.medium,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  ringClock: {
    color: colors.text,
    fontSize: typeScale.section,
    fontWeight: weight.strong,
    marginTop: 4,
  },
  available: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  stat: {
    flex: 1,
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  statValue: {
    color: colors.text,
    fontSize: typeScale.section,
    fontWeight: weight.strong,
    letterSpacing: -0.4,
  },
  statLabel: {
    color: colors.secondary,
    fontSize: 13,
    marginTop: 2,
  },
  breakCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  breakIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  breakTitle: {
    color: colors.text,
    fontSize: typeScale.secondary,
    fontWeight: weight.medium,
  },
  breakMeta: {
    color: colors.secondary,
    fontSize: 12,
    marginTop: 1,
  },
  sectionLabel: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: weight.medium,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  vehicleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  vehicleIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(201,249,76,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(201,249,76,0.30)',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  vehicleName: {
    color: colors.text,
    fontSize: typeScale.body,
    lineHeight: 25,
    fontWeight: weight.medium,
  },
  vehicleMeta: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    marginTop: 1,
  },
  readyPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(111,208,140,0.4)',
    backgroundColor: 'rgba(111,208,140,0.12)',
  },
  readyLabel: {
    color: '#6fd08c',
    fontSize: 13,
    fontWeight: weight.medium,
  },
  endShift: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 58,
    marginTop: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  endShiftPressed: {
    backgroundColor: colors.raised,
  },
  endShiftLabel: {
    color: colors.secondary,
    fontSize: typeScale.body,
    fontWeight: weight.medium,
  },
  summaryLead: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    lineHeight: 22,
    marginBottom: spacing.md,
  },
  summaryStats: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  copyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.inset,
    marginBottom: spacing.sm,
  },
  copyRowPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  copyLabel: {
    color: colors.text,
    fontSize: typeScale.secondary,
    fontWeight: weight.medium,
  },
  confirm: {
    minHeight: 56,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,138,120,0.42)',
    backgroundColor: 'rgba(255,138,120,0.12)',
  },
  confirmPressed: {
    backgroundColor: 'rgba(255,138,120,0.22)',
  },
  confirmLabel: {
    color: '#ff8a78',
    fontSize: typeScale.body,
    fontWeight: weight.strong,
  },
  cancel: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  cancelLabel: {
    color: colors.secondary,
    fontSize: typeScale.body,
    fontWeight: weight.medium,
  },
});
