/**
 * Report an issue. Reporting appends one event for dispatch and never changes the
 * response status. "Other" requires a note, exactly as the server requires.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { copy } from '../copy';
import { colors, radius, size, spacing, type, weight } from '../theme';
import { ISSUE_CATEGORIES, NOTE_LIMIT, type IssueCategory } from '../types';
import { PrimaryAction } from './PrimaryAction';
import { Sheet } from './Sheet';

interface IssueSheetProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (category: IssueCategory, note: string) => Promise<string | null>;
}

export function IssueSheet({ visible, onClose, onSubmit }: IssueSheetProps): React.JSX.Element {
  const [category, setCategory] = useState<IssueCategory | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setCategory(null);
      setNote('');
      setSubmitting(false);
      setError(null);
    }
  }, [visible]);

  const requiresNote = category === 'other';
  const canSubmit = category !== null && (!requiresNote || note.trim().length > 0) && !submitting;

  const submit = async (): Promise<void> => {
    if (category === null || !canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const message = await onSubmit(category, note);
    setSubmitting(false);
    if (message === null) {
      setCategory(null);
      setNote('');
      onClose();
      return;
    }
    setError(message);
  };

  return (
    <Sheet
      visible={visible}
      title={copy.reportIssueTitle}
      onClose={onClose}
      footer={
        <PrimaryAction
          label={copy.reportIssue}
          pending={submitting}
          disabled={!canSubmit}
          onPress={() => {
            void submit();
          }}
        />
      }
    >
      <Text maxFontSizeMultiplier={1.3} style={styles.hint}>
        {copy.reportIssueHint}
      </Text>

      {ISSUE_CATEGORIES.map((entry) => {
        const selected = category === entry.value;
        return (
          <Pressable
            key={entry.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={entry.label}
            onPress={() => {
              setCategory(entry.value);
              setError(null);
            }}
            style={[styles.row, selected && styles.rowSelected]}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              style={[styles.rowLabel, selected && styles.rowLabelSelected]}
            >
              {entry.label}
            </Text>
          </Pressable>
        );
      })}

      {requiresNote ? (
        <View style={styles.noteBlock}>
          <Text maxFontSizeMultiplier={1.3} style={styles.noteLabel}>
            {copy.describeIssue}
          </Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={NOTE_LIMIT}
            placeholder={copy.describeIssuePlaceholder}
            placeholderTextColor={colors.disabled}
            style={styles.noteInput}
            accessibilityLabel={copy.describeIssue}
          />
          <Text maxFontSizeMultiplier={1.2} style={styles.counter}>
            {note.length}/{NOTE_LIMIT}
          </Text>
        </View>
      ) : null}

      {error === null ? null : (
        <Text accessibilityRole="alert" maxFontSizeMultiplier={1.3} style={styles.error}>
          {error}
        </Text>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  hint: {
    color: colors.secondary,
    fontSize: type.meta,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  row: {
    minHeight: size.target,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.inset,
    marginBottom: spacing.sm,
  },
  rowSelected: {
    borderColor: colors.accent,
  },
  rowLabel: {
    color: colors.text,
    fontSize: type.secondary,
  },
  rowLabelSelected: {
    fontWeight: weight.medium,
  },
  noteBlock: {
    marginTop: spacing.sm,
  },
  noteLabel: {
    color: colors.secondary,
    fontSize: type.meta,
    fontWeight: weight.medium,
    marginBottom: spacing.sm,
  },
  noteInput: {
    minHeight: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.inset,
    color: colors.text,
    fontSize: type.secondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    textAlignVertical: 'top',
  },
  counter: {
    color: colors.secondary,
    fontSize: type.meta,
    alignSelf: 'flex-end',
    marginTop: spacing.xs,
  },
  error: {
    color: colors.danger,
    fontSize: type.meta,
    marginTop: spacing.sm,
  },
});
