/**
 * Trip timeline, newest first. Every row carries a 14px-start rule: accent for
 * driver-generated events, muted for dispatch.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { copy } from '../copy';
import { formatServerClock } from '../format';
import { colors, spacing, tabular, type as typeScale, weight } from '../theme';
import type { TimelineEvent } from '../types';

function EventRow({ event }: { event: TimelineEvent }): React.JSX.Element {
  const driver = event.source === 'driver';
  const clock = formatServerClock(event.created_at);
  return (
    <View
      accessible
      accessibilityLabel={`${event.kind}. ${event.message}${
        clock === null ? '' : `. ${clock}`
      }${driver ? '. Driver' : ''}`}
      style={[styles.row, driver ? styles.driverRule : styles.dispatchRule]}
    >
      <View style={styles.head}>
        <Text maxFontSizeMultiplier={1.3} style={styles.kind}>
          {event.kind}
        </Text>
        <View style={styles.meta}>
          {driver ? (
            <Text maxFontSizeMultiplier={1.2} style={styles.driverTag}>
              Driver
            </Text>
          ) : null}
          {clock === null ? null : (
            <Text maxFontSizeMultiplier={1.2} style={[styles.time, tabular]}>
              {clock}
            </Text>
          )}
        </View>
      </View>
      <Text maxFontSizeMultiplier={1.3} style={styles.message}>
        {event.message}
      </Text>
    </View>
  );
}

export function Timeline({ events }: { events: TimelineEvent[] }): React.JSX.Element {
  if (events.length === 0) {
    return (
      <Text maxFontSizeMultiplier={1.3} style={styles.empty}>
        {copy.noTimeline}
      </Text>
    );
  }

  const newestFirst = [...events].reverse();

  return (
    <View>
      {newestFirst.map((event, index) => (
        <View key={`${event.created_at}-${event.kind}-${index}`} style={index > 0 && styles.spaced}>
          <EventRow event={event} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    borderStartWidth: 3,
    paddingStart: 14,
    paddingVertical: spacing.xs,
  },
  driverRule: {
    borderStartColor: colors.accent,
  },
  dispatchRule: {
    borderStartColor: colors.hairline,
  },
  spaced: {
    marginTop: spacing.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  kind: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 20,
    fontWeight: weight.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    flexShrink: 1,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginStart: spacing.sm,
  },
  driverTag: {
    color: colors.accent,
    fontSize: typeScale.meta,
    fontWeight: weight.medium,
    marginEnd: spacing.sm,
  },
  time: {
    color: colors.secondary,
    fontSize: typeScale.meta,
  },
  message: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 23,
    marginTop: 2,
  },
  empty: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
  },
});
