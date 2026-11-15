/**
 * The glass material.
 *
 * Rules this component enforces, so callers cannot get them wrong:
 * 1. It is for the navigation and overlay layers only. Never wrap a list, a
 *    card, or scrollable content in it — Apple's guidance is explicit that
 *    Liquid Glass stays out of the content layer.
 * 2. The rim is load-bearing, not decoration: a glass panel measures 1.07:1
 *    against the canvas at every alpha, so without the 0.35 rim the surface
 *    does not exist (3.22:1 with it).
 * 3. Reduce Transparency collapses to an opaque fill and keeps the rim.
 * 4. There is no stacked glass: do not nest one of these inside another.
 *
 * Android gets a solid fill because backdrop blur there is expensive and was
 * never part of this app's visual language.
 */

import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React, { type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useReduceTransparency } from '../a11y';
import { colors, depth, glass, radius } from '../theme';

type ShadowRole = 'pill' | 'sheet' | 'toast' | 'none';

interface GlassSurfaceProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Corner radius. Use the `radius` tokens. */
  corner?: number;
  /** Sheets use a denser tint than floating pills. */
  strong?: boolean;
  shadow?: ShadowRole;
  /** The specular highlight across the top edge. Off for tiny controls. */
  sheen?: boolean;
  /** Bottom sheets round only their top corners. */
  topOnly?: boolean;
  /**
   * Fill the parent's box instead of sizing to content. Only surfaces whose
   * height is driven from outside need this — the route sheet, whose height is
   * animated.
   */
  fill?: boolean;
}

/**
 * On iOS the blur carries the material and the tint only has to darken it
 * enough for text; painting the full 0.78 tint over a blur would hide it.
 */
const IOS_TINT = 'rgba(18,20,18,0.54)';

export function GlassSurface({
  children,
  style,
  corner = radius.xxl,
  strong = false,
  shadow = 'pill',
  sheen = true,
  topOnly = false,
  fill = false,
}: GlassSurfaceProps): React.JSX.Element {
  const reduceTransparency = useReduceTransparency();
  const shape: ViewStyle = topOnly
    ? { borderTopLeftRadius: corner, borderTopRightRadius: corner }
    : { borderRadius: corner };
  const shadowStyle = shadow === 'none' || reduceTransparency ? undefined : depth[shadow];
  const fillStyle = fill ? styles.fill : undefined;

  if (reduceTransparency) {
    return (
      <View
        style={[
          styles.clip,
          fillStyle,
          shape,
          { backgroundColor: glass.opaque, borderColor: colors.rim },
          style,
        ]}
      >
        {children}
      </View>
    );
  }

  // `strong` used to resolve to the same value in both branches, so sheets and
  // pills were equally transparent and a sheet read straight through to the
  // card behind it on Android, where there is no blur to hide the gap.
  const tint = strong
    ? glass.tintStrong
    : Platform.OS === 'ios'
      ? IOS_TINT
      : glass.android;

  return (
    <View style={[shadowStyle, fillStyle, shape]}>
      <View style={[styles.clip, fillStyle, shape, { borderColor: colors.rim }, style]}>
        {Platform.OS === 'ios' ? (
          <BlurView
            intensity={strong ? glass.sheetBlurIntensity : glass.blurIntensity}
            style={StyleSheet.absoluteFill}
            tint="dark"
          />
        ) : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
        {sheen ? (
          <LinearGradient
            colors={['rgba(255,255,255,0.09)', 'rgba(255,255,255,0)']}
            end={{ x: 0.5, y: 0.44 }}
            pointerEvents="none"
            start={{ x: 0.5, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View style={styles.content}>{children}</View>
      </View>
    </View>
  );
}

/** The same material with the pill radius used by the top bar and controls. */
export function GlassPill(props: GlassSurfaceProps): React.JSX.Element {
  return <GlassSurface {...props} corner={props.corner ?? radius.xxl} />;
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
    borderWidth: 1,
  },
  content: {
    flexGrow: 1,
  },
  fill: {
    flex: 1,
  },
});
