/**
 * Activity: the record behind the toasts.
 *
 * Dispatch updates, failed deliveries, checks and shift events used to appear
 * for three seconds and vanish. Anything the app told the driver is here, with
 * the queued updates underneath it.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { copy } from '../copy';
import { formatClock } from '../format';
import { useStore } from '../store';
import { colors, radius, spacing, type as typeScale, weight } from '../theme';
import type { OutboxItem } from '../types';
import { Icon, type IconName } from './Icon';
import { OutboxSheet } from './OutboxSheet';
import { Sheet } from './Sheet';

interface ActivitySheetProps {
  visible: boolean;
  onClose: () => void;
}

const TONE_ICON: Record<'accent' | 'warning' | 'grey', IconName> = {
  accent: 'check',
  warning: 'alert',
  grey: 'clock',
};

const TONE_COLOR: Record<'accent' | 'warning' | 'grey', string> = {
  accent: colors.accent,
  warning: colors.warning,
  grey: colors.secondary,
};

export function ActivitySheet({ visible, onClose }: ActivitySheetProps): React.JSX.Element {
  const store = useStore();
  const [sending, setSending] = useState(false);
  const entries = store.activity;

  const referenceFor = (item: OutboxItem): string | null =>
    store.trips[item.tripId]?.reference ?? null;

  const sendNow = async (): Promise<void> => {
    setSending(true);
    await store.flushOutbox();
    setSending(false);
  };

  return (
    <Sheet onClose={onClose} title={copy.activityTitle} visible={visible}>
      {entries.length === 0 ? (
        <Text maxFontSizeMultiplier={1.3} style={styles.empty}>
          {copy.activityEmpty}
        </Text>
      ) : (
        <View style={styles.card}>
          {entries.map((entry, index) => (
            <View key={entry.id} style={[styles.row, index > 0 && styles.rowDivider]}>
              <View
                style={[
                  styles.iconWell,
                  { borderColor: `${TONE_COLOR[entry.tone]}44` },
                ]}
              >
                <Icon color={TONE_COLOR[entry.tone]} name={TONE_ICON[entry.tone]} size={16} />
              </View>
              <View style={styles.body}>
                <Text maxFontSizeMultiplier={1.2} numberOfLines={2} style={styles.title}>
                  {entry.title}
                </Text>
                {entry.detail === null ? null : (
                  <Text maxFontSizeMultiplier={1.2} numberOfLines={2} style={styles.detail}>
                    {entry.detail}
                  </Text>
                )}
              </View>
              <Text maxFontSizeMultiplier={1.1} style={styles.time}>
                {formatClock(new Date(entry.at)) ?? '—'}
              </Text>
            </View>
          ))}
        </View>
      )}

      <OutboxSheet
        items={store.outbox}
        onSendNow={() => {
          void sendNow();
        }}
        referenceFor={referenceFor}
        sending={sending}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  empty: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    lineHeight: 22,
    paddingVertical: spacing.md,
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
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.text,
    fontSize: typeScale.secondary,
    fontWeight: weight.medium,
    lineHeight: 20,
  },
  detail: {
    color: colors.secondary,
    fontSize: 12.5,
    lineHeight: 17,
    marginTop: 2,
  },
  time: {
    color: colors.disabled,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
});
