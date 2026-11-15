/**
 * Request backup. Dispatch receives an event; no unit is dispatched by this app,
 * so the copy never suggests that help is already moving.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { copy } from '../copy';
import { colors, radius, spacing, type } from '../theme';
import { NOTE_LIMIT } from '../types';
import { PrimaryAction } from './PrimaryAction';
import { Sheet } from './Sheet';

interface BackupSheetProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (note: string) => Promise<string | null>;
}

export function BackupSheet({ visible, onClose, onSubmit }: BackupSheetProps): React.JSX.Element {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setNote('');
      setSubmitting(false);
      setError(null);
    }
  }, [visible]);

  const submit = async (): Promise<void> => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const message = await onSubmit(note);
    setSubmitting(false);
    if (message === null) {
      setNote('');
      onClose();
      return;
    }
    setError(message);
  };

  return (
    <Sheet
      visible={visible}
      title={copy.backupTitle}
      onClose={onClose}
      footer={
        <PrimaryAction
          label={copy.requestBackup}
          pending={submitting}
          onPress={() => {
            void submit();
          }}
        />
      }
    >
      <Text maxFontSizeMultiplier={1.3} style={styles.body}>
        {copy.backupBody}
      </Text>
      <TextInput
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={NOTE_LIMIT}
        placeholder={copy.backupNotePlaceholder}
        placeholderTextColor={colors.disabled}
        style={styles.input}
        accessibilityLabel={copy.backupNotePlaceholder}
      />
      <View style={styles.counterRow}>
        <Text maxFontSizeMultiplier={1.2} style={styles.counter}>
          {note.length}/{NOTE_LIMIT}
        </Text>
      </View>
      {error === null ? null : (
        <Text accessibilityRole="alert" maxFontSizeMultiplier={1.3} style={styles.error}>
          {error}
        </Text>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.text,
    fontSize: type.secondary,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  input: {
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
  counterRow: {
    alignItems: 'flex-end',
    marginTop: spacing.xs,
  },
  counter: {
    color: colors.secondary,
    fontSize: type.meta,
  },
  error: {
    color: colors.danger,
    fontSize: type.meta,
    marginTop: spacing.sm,
  },
});
