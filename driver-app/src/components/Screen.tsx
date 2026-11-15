/**
 * Screen frame: the stage.
 *
 * Ordering is explicit and not negotiable — map at the back, then a legibility
 * scrim, then content, then the floating chrome (pill, dock). Content scrolls
 * underneath the chrome, which is what makes the shell feel layered rather than
 * boxed in.
 *
 * Glass belongs on the pill and the dock only; whatever a screen puts in
 * `children` is content and stays flat.
 */

import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReduceMotion } from '../a11y';
import { aura, colors, contentMaxWidth, motion, spacing, stageBottom, stageTop } from '../theme';

interface ScreenProps {
  children: ReactNode;
  /** Full-bleed map stage rendered behind everything. */
  map?: ReactNode;
  /** Floating top bar. */
  pill?: ReactNode;
  /** Floating bottom dock. */
  footer?: ReactNode;
  /**
   * A sheet that owns the bottom edge, such as Home's route sheet. It is drawn
   * above the dock and scroll content, and it replaces the body's bottom pad.
   */
  sheet?: ReactNode;
  /**
   * Lifts the dock off the bottom edge by this many px so it clears a sheet.
   * When set, the safe-area bottom inset is no longer applied: the sheet is
   * already covering it.
   */
  footerOffset?: number;
  busy?: boolean;
  /** Override the scroll insets when a screen has unusual chrome. */
  contentTop?: number;
  contentBottom?: number;
  /** Draws the ambient aura when there is no map. */
  aura?: boolean;
}

export function Screen({
  children,
  map,
  pill,
  footer,
  sheet,
  footerOffset,
  busy = false,
  contentTop,
  contentBottom,
  aura: showAura = true,
}: ScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: reduceMotion ? 0 : motion.push,
      useNativeDriver: true,
    }).start();
  }, [opacity, reduceMotion]);

  const padTop = contentTop ?? (pill === undefined ? spacing.lg : stageTop) + insets.top;
  const padBottom =
    contentBottom ??
    (footer === undefined ? spacing.lg : stageBottom) +
      (footerOffset === undefined ? insets.bottom : footerOffset);

  return (
    <View style={styles.root}>
      {map === undefined ? (
        showAura ? (
          <AmbientAura />
        ) : null
      ) : (
        <View style={StyleSheet.absoluteFill}>{map}</View>
      )}

      {/* Keeps status-bar content legible over a map without tinting the whole stage. */}
      <LinearGradient
        colors={['rgba(8,10,9,0.82)', 'rgba(8,10,9,0.20)', 'rgba(8,10,9,0)']}
        locations={[0, 0.55, 1]}
        pointerEvents="none"
        style={[styles.topScrim, { height: insets.top + 120 }]}
      />

      {busy ? <View style={[styles.busyLine, { top: insets.top }]} /> : null}

      {/*
       * box-none, not auto: this frame covers the whole screen, and a plain View
       * on top of the map swallowed every pan and zoom gesture aimed at it.
       */}
      <Animated.View
        pointerEvents="box-none"
        style={[styles.body, { opacity, paddingTop: padTop, paddingBottom: padBottom }]}
      >
        {children}
      </Animated.View>

      {pill === undefined ? null : (
        <View
          pointerEvents="box-none"
          style={[styles.pillWrap, { top: insets.top + spacing.sm }]}
        >
          {pill}
        </View>
      )}

      {footer === undefined ? null : (
        <View
          pointerEvents="box-none"
          style={[
            styles.footerWrap,
            {
              paddingBottom:
                footerOffset === undefined
                  ? insets.bottom + spacing.md
                  : footerOffset + spacing.sm,
            },
          ]}
        >
          <View style={styles.column}>{footer}</View>
        </View>
      )}

      {sheet === undefined ? null : (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {sheet}
        </View>
      )}
    </View>
  );
}

/** Two soft colour fields so the glass has something to refract. */
function AmbientAura(): React.JSX.Element {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.auraAccent]} />
      <View style={[styles.auraCool]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  body: {
    flex: 1,
  },
  topScrim: {
    position: 'absolute',
    top: 0,
    start: 0,
    end: 0,
  },
  busyLine: {
    position: 'absolute',
    start: 0,
    end: 0,
    height: 2,
    backgroundColor: colors.accent,
  },
  pillWrap: {
    position: 'absolute',
    start: spacing.md,
    end: spacing.md,
    // Stretch, not center: a glass surface sizes itself from its parent, so
    // centering collapsed the pill to the width of its back button.
    alignItems: 'stretch',
  },
  footerWrap: {
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
    paddingHorizontal: spacing.md,
  },
  column: {
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
  },
  auraAccent: {
    position: 'absolute',
    width: 520,
    height: 520,
    borderRadius: 260,
    start: -170,
    top: -180,
    backgroundColor: aura.accent,
  },
  auraCool: {
    position: 'absolute',
    width: 460,
    height: 460,
    borderRadius: 230,
    end: -160,
    bottom: 40,
    backgroundColor: aura.cool,
  },
});
