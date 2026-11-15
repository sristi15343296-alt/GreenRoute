/**
 * The check sheet, used twice: before accepting (vehicle kit) and before
 * closing a response (scene handover). Same rows, same progress, same rule —
 * the primary action stays disabled until every item is ticked.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { copy } from '../copy';
import type { CheckItem } from '../equipment';
import { colors, radius, spacing, type as typeScale, weight } from '../theme';
import { Icon } from './Icon';
import { PrimaryAction } from './PrimaryAction';
import { Sheet } from './Sheet';

interface TransitionCheckSheetProps {
  visible: boolean;
  title: string;
  subtitle?: string | null;
  items: CheckItem[];
  confirmLabel: string;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (note: string, count: number) => void;
}

export function TransitionCheckSheet({
  visible,
  title,
  subtitle,
  items,
  confirmLabel,
  pending = false,
  onClose,
  onConfirm,
}: TransitionCheckSheetProps): React.JSX.Element {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const { height: windowHeight } = useWindowDimensions();

  // Every visit starts from a clean sheet: a tick from the last response says
  // nothing about this one.
  useEffect(() => {
    if (visible) {
      setChecked({});
      setNote('');
    }
  }, [visible]);

  const done = useMemo(
    () => items.filter((item) => checked[item.id] === true).length,
    [checked, items]
  );
  const complete = items.length > 0 && done === items.length;
  const remaining = items.length - done;

  const toggle = (id: string): void => {
    setChecked((current) => ({ ...current, [id]: current[id] !== true }));
  };

  return (
    <Sheet
      visible={visible}
      title={title}
      onClose={onClose}
      footer={
        <PrimaryAction
          disabled={!complete}
          label={complete ? confirmLabel : `${remaining} ${copy.checkRemaining}`}
          pending={pending}
          onPress={() => onConfirm(note.trim(), done)}
        />
      }
    >
      {subtitle === undefined || subtitle === null || subtitle.length === 0 ? null : (
        <Text maxFontSizeMultiplier={1.2} style={styles.subtitle}>
          {subtitle}
        </Text>
      )}

      <Text maxFontSizeMultiplier={1.2} style={styles.count}>
        <Text style={styles.countDone}>{done}</Text>
        {` of ${items.length}  `}
        <Text style={styles.countMuted}>
          {complete ? copy.checkAllDone : copy.checkRequired}
        </Text>
      </Text>

      <View style={styles.progress}>
        {items.map((item) => (
          <View
            key={item.id}
            style={[styles.segment, checked[item.id] === true && styles.segmentOn]}
          />
        ))}
      </View>

      {/* The list scrolls inside the sheet rather than scrolling the sheet:
          a long kit must never push the Accept action off the screen. */}
      <ScrollView
        contentContainerStyle={styles.card}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: Math.round(windowHeight * 0.44) }}
      >
        {items.map((item, index) => {
          const on = checked[item.id] === true;
          return (
            <Pressable
              accessibilityLabel={`${item.label}, ${on ? 'checked' : 'not checked'}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              key={item.id}
              onPress={() => toggle(item.id)}
              style={({ pressed }) => [
                styles.row,
                index > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
            >
              <View style={[styles.box, on && styles.boxOn]}>
                {on ? <Icon color={colors.onAccent} name="check" size={15} /> : null}
              </View>
              <View style={styles.grow}>
                <Text maxFontSizeMultiplier={1.2} style={[styles.label, on && styles.labelOn]}>
                  {item.label}
                </Text>
                <Text maxFontSizeMultiplier={1.2} style={styles.group}>
                  {item.group}
                </Text>
              </View>
              {item.detail === null ? null : (
                <Text maxFontSizeMultiplier={1.2} style={styles.detail}>
                  {item.detail}
                </Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      <TextInput
        accessibilityLabel={copy.checkNote}
        maxFontSizeMultiplier={1.2}
        multiline={false}
        onChangeText={setNote}
        placeholder={copy.checkNote}
        placeholderTextColor={colors.disabled}
        returnKeyType="done"
        style={styles.note}
        value={note}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    lineHeight: 19,
    marginTop: -2,
  },
  count: {
    color: colors.text,
    fontSize: 15,
    fontWeight: weight.medium,
    marginTop: spacing.md,
  },
  countDone: {
    color: colors.accent,
    fontSize: 24,
    fontWeight: weight.strong,
    letterSpacing: -0.4,
  },
  countMuted: {
    color: colors.secondary,
    fontWeight: weight.regular,
  },
  progress: {
    flexDirection: 'row',
    gap: 4,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  segment: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  segmentOn: {
    backgroundColor: colors.accent,
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
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  box: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 20,
    fontWeight: weight.medium,
  },
  labelOn: {
    color: colors.text,
  },
  group: {
    color: colors.disabled,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 1,
  },
  detail: {
    color: colors.secondary,
    fontSize: 12.5,
    marginStart: 8,
  },
  note: {
    marginTop: spacing.md,
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: typeScale.secondary,
  },
});
