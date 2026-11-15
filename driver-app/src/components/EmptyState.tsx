/**
 * One sentence and one next step. No illustrations, no placeholder copy.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing, type, weight } from '../theme';

interface EmptyStateProps {
  title: string;
  action?: ReactNode;
}

export function EmptyState({ title, action }: EmptyStateProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text maxFontSizeMultiplier={1.3} style={styles.title}>
        {title}
      </Text>
      {action === undefined ? null : <View style={styles.action}>{action}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  title: {
    color: colors.text,
    fontSize: type.section,
    lineHeight: 32,
    fontWeight: weight.medium,
    textAlign: 'center',
  },
  action: {
    marginTop: spacing.xl,
    alignSelf: 'stretch',
  },
});
