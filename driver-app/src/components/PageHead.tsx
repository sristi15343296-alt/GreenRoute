/**
 * The page heading, in content.
 *
 * Big enough to be the anchor of the screen, outside the pill, so it can never
 * be squeezed by a caption, a badge or the pill's corner radius.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, type as typeScale, weight } from '../theme';

interface PageHeadProps {
  title: string;
  subtitle?: string | null;
}

export function PageHead({ title, subtitle }: PageHeadProps): React.JSX.Element {
  return (
    <View style={styles.wrap}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={1.2} style={styles.title}>
        {title}
      </Text>
      {subtitle === undefined || subtitle === null || subtitle.length === 0 ? null : (
        <Text maxFontSizeMultiplier={1.3} style={styles.subtitle}>
          {subtitle}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 2,
    paddingTop: 6,
    paddingBottom: 2,
  },
  title: {
    color: colors.text,
    fontSize: typeScale.hero,
    lineHeight: 38,
    fontWeight: weight.strong,
    letterSpacing: -0.9,
  },
  subtitle: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
});
