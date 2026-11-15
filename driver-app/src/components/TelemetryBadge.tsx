/**
 * The one place the driver is told whether dispatch can see the vehicle.
 *
 * Four facts, no jargon: is sharing on, how fresh was the last fix, how accurate
 * is it, and how many positions are waiting to be sent. When sharing is off or
 * degraded the row explains why in a sentence, because "GPS error 3" is not an
 * instruction a crew can act on.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ShareView } from '../location';
import { alpha, colors, radius, size, spacing, type as typeScale, weight } from '../theme';

interface TelemetryBadgeProps {
  telemetry: ShareView;
  /** Milliseconds since the last accepted fix; null when there has never been one. */
  ageMs: number | null;
}

function toneFor(view: ShareView): string {
  switch (view.state) {
    case 'active':
      return colors.accent;
    case 'starting':
      return colors.accent;
    case 'degraded':
      return colors.warning;
    case 'denied':
    case 'unauthorised':
      return colors.danger;
    case 'paused':
      return colors.secondary;
    default:
      return colors.disabled;
  }
}

function labelFor(view: ShareView): string {
  switch (view.state) {
    case 'active':
      return 'Location shared';
    case 'starting':
      return 'Starting GPS…';
    case 'paused':
      return 'Location paused';
    case 'degraded':
      return 'Location buffered';
    case 'denied':
      return 'Location blocked';
    case 'unauthorised':
      return 'Location stopped';
    default:
      return 'Location off';
  }
}

function detailFor(view: ShareView, ageMs: number | null): string {
  if (view.state === 'active') {
    if (ageMs !== null && ageMs < 60_000) {
      const accuracy = view.accuracyM === null ? '' : ` · ±${Math.round(view.accuracyM)} m`;
      return `Dispatch sees this unit${accuracy}`;
    }
    return 'Waiting for a GPS fix';
  }
  if (view.state === 'degraded' && view.buffered > 0) {
    return `${view.buffered} position${view.buffered === 1 ? '' : 's'} waiting to send`;
  }
  return view.message;
}

export function TelemetryBadge({ telemetry, ageMs }: TelemetryBadgeProps): React.JSX.Element {
  const tint = toneFor(telemetry);
  const detail = detailFor(telemetry, ageMs);
  return (
    <View
      accessible
      accessibilityLabel={`Location sharing: ${labelFor(telemetry)}. ${detail}`}
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      style={[styles.row, { borderColor: alpha(tint, 0.3), backgroundColor: alpha(tint, 0.07) }]}
    >
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <View style={styles.text}>
        <Text maxFontSizeMultiplier={1.3} style={[styles.label, { color: tint }]}>
          {labelFor(telemetry)}
        </Text>
        <Text maxFontSizeMultiplier={1.3} numberOfLines={2} style={styles.detail}>
          {detail}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: size.banner,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  dot: {
    width: size.dot,
    height: size.dot,
    borderRadius: size.dot / 2,
    marginEnd: spacing.sm + 1,
  },
  text: {
    flex: 1,
  },
  label: {
    fontSize: typeScale.meta,
    fontWeight: weight.medium,
    letterSpacing: 0.2,
  },
  detail: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    marginTop: 1,
  },
});
