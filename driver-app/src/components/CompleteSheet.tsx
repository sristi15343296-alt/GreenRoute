/**
 * Completing a response is the one irreversible action for a crew, so it is the
 * only action that asks first.
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { copy } from '../copy';
import { colors, size, spacing, type, weight } from '../theme';
import { PrimaryAction } from './PrimaryAction';
import { Sheet } from './Sheet';

interface CompleteSheetProps {
  visible: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function CompleteSheet({
  visible,
  pending,
  onClose,
  onConfirm,
}: CompleteSheetProps): React.JSX.Element {
  return (
    <Sheet
      visible={visible}
      title={copy.completeConfirmTitle}
      onClose={onClose}
      footer={
        <>
          <PrimaryAction label={copy.complete} pending={pending} onPress={onConfirm} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.cancel}
            onPress={onClose}
            style={styles.cancel}
          >
            <Text maxFontSizeMultiplier={1.3} style={styles.cancelLabel}>
              {copy.cancel}
            </Text>
          </Pressable>
        </>
      }
    >
      <Text maxFontSizeMultiplier={1.3} style={styles.body}>
        {copy.completeConfirmBody}
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.text,
    fontSize: type.body,
    lineHeight: 23,
    marginBottom: spacing.sm,
  },
  cancel: {
    minHeight: size.target,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  cancelLabel: {
    color: colors.secondary,
    fontSize: type.body,
    fontWeight: weight.medium,
  },
});
