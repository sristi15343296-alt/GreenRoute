/**
 * Pre-shift vehicle check.
 *
 * Local to this session: dispatch has no checklist endpoint, so a completed
 * check is acknowledged here and nothing is claimed to have been sent. The ring
 * and the count are the whole point — the driver can see what is left without
 * counting rows.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { PageHead } from '../components/PageHead';
import { PrimaryAction } from '../components/PrimaryAction';
import { Ring } from '../components/Ring';
import { Screen } from '../components/Screen';
import { TopBar } from '../components/TopBar';
import { copy } from '../copy';
import { DEMO_CHECKLIST, type ChecklistItem } from '../demo';
import { useStore } from '../store';
import {
  colors,
  contentMaxWidth,
  radius,
  spacing,
  type as typeScale,
  weight,
} from '../theme';

export function ChecklistScreen(): React.JSX.Element {
  const store = useStore();
  const [items, setItems] = useState<ChecklistItem[]>(() =>
    DEMO_CHECKLIST.map((entry) => ({ ...entry }))
  );

  const done = items.filter((entry) => entry.done).length;
  const remaining = items.length - done;
  const ready = remaining === 0;
  const progress = useMemo(() => (items.length === 0 ? 1 : done / items.length), [done, items.length]);

  const toggle = (id: string): void => {
    setItems((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, done: !entry.done } : entry))
    );
  };

  return (
    <Screen
      footer={
        <View style={styles.footerColumn}>
          <PrimaryAction
            disabled={!ready}
            label={copy.finishCheck}
            onPress={() => {
              store.showNotice('Vehicle check complete. Unit is dispatch-ready.');
              store.pop();
            }}
          />
        </View>
      }
      pill={
        <TopBar
          caption={`${store.callSign ?? 'Unit'} · before shift`}
          onBack={store.pop}
          title={store.callSign ?? 'Unit'}
        />
      }
    >
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.column}>
          <PageHead subtitle={copy.checklistSubtitle} title={copy.checklist} />

          <View style={styles.head}>
            <Ring progress={progress} size={84} thickness={8} />
            <View style={styles.headText}>
              <Text maxFontSizeMultiplier={1.2} style={styles.count}>
                {done} of {items.length}
              </Text>
              <Text maxFontSizeMultiplier={1.3} style={styles.hint}>
                {ready
                  ? copy.checklistReady
                  : `${remaining} ${copy.checklistPending}`}
              </Text>
            </View>
          </View>

          <View style={styles.card}>
            {items.map((entry, index) => (
              <View key={entry.id}>
                {index > 0 ? <View style={styles.rule} /> : null}
                <Pressable
                  accessibilityLabel={`${entry.label}${entry.detail === null ? '' : `, ${entry.detail}`}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: entry.done }}
                  onPress={() => toggle(entry.id)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <View style={[styles.box, entry.done && styles.boxOn]}>
                    {entry.done ? <Icon color={colors.onAccent} name="check" size={15} /> : null}
                  </View>
                  <Text
                    maxFontSizeMultiplier={1.3}
                    style={[styles.label, entry.done && styles.labelDone]}
                  >
                    {entry.label}
                  </Text>
                  {entry.detail === null ? null : (
                    <Text
                      maxFontSizeMultiplier={1.2}
                      style={[styles.detail, !entry.done && styles.detailWarn]}
                    >
                      {entry.detail}
                    </Text>
                  )}
                </Pressable>
              </View>
            ))}
          </View>

          <Text maxFontSizeMultiplier={1.2} style={styles.note}>
            {copy.demoData} · checked items live on this device only.
          </Text>
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
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.lg,
  },
  headText: {
    flex: 1,
    minWidth: 0,
  },
  count: {
    color: colors.text,
    fontSize: typeScale.section,
    fontWeight: weight.strong,
    letterSpacing: -0.4,
  },
  hint: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 21,
    marginTop: 2,
  },
  card: {
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.sm,
  },
  rowPressed: {
    opacity: 0.8,
  },
  rule: {
    height: 1,
    backgroundColor: colors.hairline,
  },
  box: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.rim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  label: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 22,
  },
  labelDone: {
    color: colors.secondary,
  },
  detail: {
    color: colors.secondary,
    fontSize: typeScale.meta,
  },
  detailWarn: {
    color: colors.warning,
  },
  note: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.md,
  },
  footerColumn: {
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
  },
});
