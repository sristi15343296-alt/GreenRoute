/**
 * Bottom sheet chrome: glass, 30px top corners, grabber, 60% scrim.
 *
 * This is an overlay surface, so it is allowed to be glass — but it never
 * stacks on another glass surface: while a sheet is open the dock is not
 * rendered, and the sheet dims the stage instead.
 */

import React, { type ReactNode, useEffect } from 'react';
import { useWindowDimensions } from 'react-native';
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { copy } from '../copy';
import { colors, radius, scrim, spacing, type as typeScale, weight } from '../theme';
import { GlassSurface } from './Glass';

interface SheetProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
}: SheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    if (visible && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(title);
    }
  }, [visible, title]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          accessibilityLabel={copy.close}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.scrim}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.wrap}
        >
          <GlassSurface
            corner={radius.xxl}
            shadow="sheet"
            strong
            style={[
              styles.sheet,
              // A percentage maxHeight leaves the sheet's children without a bound
              // to measure against, which collapses the scroll area to nothing.
              { maxHeight: Math.round(windowHeight * 0.88) },
              { paddingBottom: insets.bottom + spacing.lg },
            ]}
            topOnly
          >
            <View style={styles.grabber} />
            <View style={styles.header}>
              <Text
                accessibilityRole="header"
                maxFontSizeMultiplier={1.3}
                style={styles.title}
              >
                {title}
              </Text>
              <Pressable
                accessibilityLabel={copy.close}
                accessibilityRole="button"
                onPress={onClose}
                style={styles.close}
              >
                <Text maxFontSizeMultiplier={1.2} style={styles.closeLabel}>
                  {copy.close}
                </Text>
              </Pressable>
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={styles.scroll}
              contentContainerStyle={styles.body}
            >
              {children}
            </ScrollView>
            {footer === undefined ? null : <View style={styles.footer}>{footer}</View>}
          </GlassSurface>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    start: 0,
    end: 0,
    bottom: 0,
    backgroundColor: scrim,
  },
  wrap: {
    justifyContent: 'flex-end',
  },
  sheet: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.32)',
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: typeScale.section,
    lineHeight: 30,
    fontWeight: weight.medium,
    flexShrink: 1,
  },
  close: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  closeLabel: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    fontWeight: weight.medium,
  },
  body: {
    paddingBottom: spacing.sm,
  },
  // The sheet is content-sized, so the scroll area must take its natural height
  // and only give up space when the sheet hits maxHeight.
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  footer: {
    paddingTop: spacing.md,
  },
});
