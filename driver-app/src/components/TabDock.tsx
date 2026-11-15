/**
 * The tab dock.
 *
 * Navigation layer, so it is glass — the one bottom surface this app allows
 * when no sheet is open. On Home it floats above the route sheet and rises with
 * it; on the list screens it sits on the bottom edge.
 *
 * Every tab carries a label. An icon-only dock is a memory test, and a driver
 * wearing gloves at night is not the person to give one to.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, size, spacing, weight } from '../theme';
import { GlassSurface } from './Glass';
import { Icon, type IconName } from './Icon';

export type TabName = 'home' | 'queue' | 'history' | 'profile';

const TABS: ReadonlyArray<{ name: TabName; label: string; icon: IconName }> = [
  { name: 'home', label: 'Home', icon: 'home' },
  { name: 'queue', label: 'Queue', icon: 'layers' },
  { name: 'history', label: 'History', icon: 'history' },
  { name: 'profile', label: 'Profile', icon: 'user' },
];

interface TabDockProps {
  active: TabName;
  onSelect: (tab: TabName) => void;
}

export function TabDock({ active, onSelect }: TabDockProps): React.JSX.Element {
  return (
    <GlassSurface corner={radius.xxl} style={styles.dock}>
      <View accessibilityRole="tablist" style={styles.row}>
        {TABS.map((tab) => {
          const selected = tab.name === active;
          return (
            <Pressable
              accessibilityLabel={tab.label}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              key={tab.name}
              onPress={() => {
                if (!selected) {
                  onSelect(tab.name);
                }
              }}
              style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
            >
              <Icon
                color={selected ? colors.accent : colors.secondary}
                name={tab.icon}
                size={21}
              />
              <Text
                maxFontSizeMultiplier={1.2}
                style={[styles.label, selected && styles.labelActive]}
              >
                {tab.label}
              </Text>
              <View style={[styles.marker, selected && styles.markerActive]} />
            </Pressable>
          );
        })}
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  dock: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
  },
  row: {
    flexDirection: 'row',
  },
  tab: {
    flex: 1,
    minHeight: size.target,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing.sm,
    paddingBottom: 6,
    borderRadius: radius.lg,
  },
  tabPressed: {
    opacity: 0.72,
  },
  label: {
    color: colors.secondary,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: weight.medium,
    marginTop: 3,
  },
  labelActive: {
    color: colors.accent,
  },
  marker: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 3,
    backgroundColor: 'transparent',
  },
  markerActive: {
    backgroundColor: colors.accent,
  },
});
