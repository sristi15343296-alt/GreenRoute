/**
 * The assignment card. Every nullable field either shows its value or the whole
 * row disappears — no dashes, no empty pills, no "undefined".
 *
 * This is content, so it stays flat: no blur, no rim. Depth comes from the
 * shadow and the hairline border only.
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAnnouncements } from '../a11y';
import {
  formatDispatchAt,
  formatDistance,
  formatDuration,
  formatEmergencyType,
} from '../format';
import {
  colors,
  priorityTint,
  radius,
  spacing,
  statusTint,
  tabular,
  type as typeScale,
  weight,
} from '../theme';
import type { Trip } from '../types';
import { Icon } from './Icon';
import { ProgressRail } from './ProgressRail';
import { SendingPill } from './SendingPill';
import { StatusChip } from './StatusChip';

interface TripSummaryProps {
  trip: Trip;
  pending: boolean;
  unconfirmed: boolean;
}

export function TripSummary({ trip, pending, unconfirmed }: TripSummaryProps): React.JSX.Element {
  const announcements = useMemo(
    () => [{ label: 'Status', text: trip.status_label }],
    [trip.status_label]
  );
  useAnnouncements(announcements);

  const emergency = formatEmergencyType(trip.emergency_type);
  const distance = formatDistance(trip.distance_km);
  const duration = formatDuration(trip.duration_min);
  const dispatched = formatDispatchAt(trip.dispatch_at);
  const tint = priorityTint(trip.priority);

  return (
    <View style={styles.card}>
      <View style={styles.chipRow}>
        <StatusChip label={trip.status_label} status={trip.status} />
        {pending ? <SendingPill unconfirmed={unconfirmed} /> : null}
      </View>

      <ProgressRail status={trip.status} />

      <View style={styles.referenceRow}>
        <Text maxFontSizeMultiplier={1.3} style={[styles.reference, tabular]}>
          {trip.reference}
        </Text>
        <View style={[styles.priorityPill, { borderColor: tint }]}>
          <Text maxFontSizeMultiplier={1.2} style={[styles.priorityLabel, { color: tint }]}>
            {trip.priority_label}
          </Text>
        </View>
      </View>

      {emergency === null ? null : (
        <Text maxFontSizeMultiplier={1.3} style={styles.emergency}>
          {emergency}
        </Text>
      )}

      <View style={styles.route}>
        <Text maxFontSizeMultiplier={1.3} numberOfLines={2} style={styles.origin}>
          {trip.origin}
        </Text>
        <Text maxFontSizeMultiplier={1.3} style={styles.destination}>
          {trip.destination}
        </Text>
      </View>

      {distance === null && duration === null ? null : (
        <View style={styles.stats}>
          {distance === null ? null : (
            <View style={styles.stat}>
              <Icon color={colors.secondary} name="nav" size={17} />
              <View>
                <Text maxFontSizeMultiplier={1.2} style={[styles.statValue, tabular]}>
                  {distance}
                </Text>
                <Text maxFontSizeMultiplier={1.2} style={styles.statLabel}>
                  to destination
                </Text>
              </View>
            </View>
          )}
          {duration === null ? null : (
            <View style={styles.stat}>
              <Icon color={colors.secondary} name="clock" size={17} />
              <View>
                <Text maxFontSizeMultiplier={1.2} style={[styles.statValue, tabular]}>
                  {duration}
                </Text>
                <Text maxFontSizeMultiplier={1.2} style={styles.statLabel}>
                  estimated
                </Text>
              </View>
            </View>
          )}
        </View>
      )}

      {dispatched === null ? null : (
        <View style={styles.dispatched}>
          <Text maxFontSizeMultiplier={1.2} style={styles.dispatchedLabel}>
            Dispatched
          </Text>
          <Text maxFontSizeMultiplier={1.2} style={[styles.dispatchedValue, tabular]}>
            {dispatched}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  referenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  reference: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 20,
    letterSpacing: 0.5,
    fontWeight: weight.medium,
  },
  priorityPill: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  priorityLabel: {
    fontSize: typeScale.meta,
    lineHeight: 19,
    fontWeight: weight.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  emergency: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    lineHeight: 24,
    marginTop: spacing.sm,
  },
  route: {
    marginTop: spacing.md,
  },
  origin: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    lineHeight: 24,
  },
  destination: {
    color: colors.text,
    fontSize: typeScale.section,
    lineHeight: 30,
    fontWeight: weight.medium,
    letterSpacing: -0.3,
    marginTop: spacing.xs,
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  stat: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.inset,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  statValue: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 22,
    fontWeight: weight.strong,
  },
  statLabel: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 18,
  },
  dispatched: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  dispatchedLabel: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 20,
  },
  dispatchedValue: {
    color: colors.text,
    fontSize: typeScale.meta,
    lineHeight: 20,
    fontWeight: weight.medium,
  },
});

export const statusTintForCard = statusTint;
