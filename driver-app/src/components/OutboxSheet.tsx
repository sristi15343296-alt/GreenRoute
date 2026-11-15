/**
 * The queued updates.
 *
 * Rendered as a section inside the activity sheet rather than as its own modal:
 * two sheets stacked over a map is one scrim too many. The section carries what
 * the count never did — which update, how many attempts, what went wrong — and
 * a Send now that skips the backoff.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { copy } from '../copy';
import { formatClock } from '../format';
import { colors, radius, spacing, type as typeScale, weight } from '../theme';
import type { OutboxItem } from '../types';
import { Icon } from './Icon';

interface OutboxSheetProps {
  items: OutboxItem[];
  /** Trip reference for a queued update, when the list still knows the trip. */
  referenceFor: (item: OutboxItem) => string | null;
  onSendNow: () => void;
  sending?: boolean;
}

export function OutboxSheet({
  items,
  referenceFor,
  onSendNow,
  sending = false,
}: OutboxSheetProps): React.JSX.Element | null {
  if (items.length === 0) {
    return null;
  }

  return (
    <View style={styles.wrap}>
      <Text maxFontSizeMultiplier={1.2} style={styles.heading}>
        {copy.outboxTitle}
      </Text>

      <View style={styles.card}>
        {items.map((item, index) => {
          const reference = referenceFor(item);
          return (
            <View key={item.id} style={[styles.row, index > 0 && styles.rowDivider]}>
              <View style={styles.iconWell}>
                <Icon color={colors.warning} name="clock" size={16} />
              </View>
              <View style={styles.body}>
                <Text maxFontSizeMultiplier={1.2} style={styles.title}>
                  {reference ?? `#${item.tripId}`} · {item.to.replace(/_/g, ' ')}
                </Text>
                <Text maxFontSizeMultiplier={1.2} style={styles.meta}>
                  {`${item.attempts} ${item.attempts === 1 ? 'attempt' : 'attempts'} · queued ${
                    formatClock(new Date(item.createdAt)) ?? '—'
                  }`}
                </Text>
                {item.lastError === null ? null : (
                  <Text maxFontSizeMultiplier={1.2} numberOfLines={2} style={styles.error}>
                    {item.lastError}
                  </Text>
                )}
              </View>
              <Pressable
                accessibilityLabel={`${copy.sendNow}, ${reference ?? item.tripId}`}
                accessibilityRole="button"
                disabled={sending}
                onPress={onSendNow}
                style={({ pressed }) => [
                  styles.send,
                  pressed && styles.sendPressed,
                  sending && styles.sendDisabled,
                ]}
              >
                <Text maxFontSizeMultiplier={1.1} style={styles.sendLabel}>
                  {copy.sendNow}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: spacing.lg,
  },
  heading: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: weight.medium,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.inset,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  iconWell: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,196,102,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,196,102,0.28)',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.text,
    fontSize: typeScale.secondary,
    fontWeight: weight.medium,
    textTransform: 'capitalize',
  },
  meta: {
    color: colors.disabled,
    fontSize: 12,
    marginTop: 2,
  },
  error: {
    color: colors.warning,
    fontSize: 12,
    marginTop: 3,
  },
  send: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(201,249,76,0.36)',
    backgroundColor: 'rgba(201,249,76,0.10)',
  },
  sendPressed: {
    backgroundColor: 'rgba(201,249,76,0.2)',
  },
  sendDisabled: {
    opacity: 0.5,
  },
  sendLabel: {
    color: colors.accent,
    fontSize: 12.5,
    fontWeight: weight.strong,
  },
});
