/**
 * The route sheet.
 *
 * Three snap points — peek, half, full — dragged from the grabber. The point of
 * the whole component is the peek state: the driver sees the entire route, both
 * endpoints and the ETA, without the details covering it. Detail is what the
 * other two snaps are for.
 *
 * The height lives in an Animated value because it is the sheet's own chrome;
 * the camera inset is reported to the screen only when a snap settles, so a drag
 * never re-frames the map on every frame.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReduceMotion } from '../a11y';
import {
  formatDispatchAt,
  formatDistance,
  formatDuration,
  formatEmergencyType,
} from '../format';
import {
  colors,
  contentMaxWidth,
  radius,
  spacing,
  tabular,
  type as typeScale,
  weight,
} from '../theme';
import type { Trip } from '../types';
import { TripActions } from './AssignmentFooter';
import { GlassSurface } from './Glass';
import { Icon } from './Icon';
import { ProgressRail } from './ProgressRail';
import { SendingPill } from './SendingPill';
import { StatusChip } from './StatusChip';
import { Timeline } from './Timeline';

export type SheetSnap = 'peek' | 'half' | 'full';

const ORDER: readonly SheetSnap[] = ['peek', 'half', 'full'];

/** mm:ss under an hour, h:mm:ss above it. */
function formatOnTask(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The peek snap is not a hard-coded number: it is whatever the header and the
 * action row actually measure. A fixed height left a sliver of the detail area
 * showing under the origin line, which read as a clipped screen.
 */

interface TripSheetProps {
  trip: Trip;
  pending: boolean;
  unconfirmed: boolean;
  snap: SheetSnap;
  /** Connection banner, shown at the top of the detail area. */
  banner?: ReactNode;
  onSnap: (snap: SheetSnap) => void;
  /** Settled height in px, for the camera inset and the dock offset. */
  onHeight: (height: number) => void;
  /** The store's clock, so the on-task timer ticks with everything else. */
  nowMs?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function TripSheet({
  trip,
  pending,
  unconfirmed,
  snap,
  banner,
  onSnap,
  onHeight,
  nowMs,
}: TripSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const reduceMotion = useReduceMotion();

  const [chrome, setChrome] = useState({ header: 0, footer: 0 });

  const heights = useMemo(() => {
    const usable = windowHeight - insets.top;
    const measured = chrome.header + chrome.footer + insets.bottom + spacing.xs;
    const peek = Math.min(measured || Math.round(usable * 0.34), Math.round(usable * 0.5));
    return {
      peek,
      half: Math.round(usable * 0.58),
      full: usable - spacing.sm,
    };
  }, [windowHeight, insets.top, insets.bottom, chrome]);

  const heightsRef = useRef(heights);
  heightsRef.current = heights;

  const height = useRef(new Animated.Value(heights.peek)).current;
  const current = useRef(heights.peek);
  const dragStart = useRef(heights.peek);

  const animateTo = useCallback(
    (next: SheetSnap) => {
      const target = heightsRef.current[next];
      current.current = target;
      Animated.spring(height, {
        toValue: target,
        useNativeDriver: false,
        overshootClamping: true,
        stiffness: 240,
        damping: 32,
        mass: 0.9,
      }).start();
      onHeight(target);
    },
    [height, onHeight]
  );

  const setSnap = useCallback(
    (next: SheetSnap) => {
      onSnap(next);
      animateTo(next);
    },
    [animateTo, onSnap]
  );

  // Follow an externally requested snap (the expand button, or a screen reset)
  // without fighting the gesture that may already be settling.
  useEffect(() => {
    if (Math.abs(current.current - heights[snap]) > 1) {
      animateTo(snap);
    }
  }, [snap, heights, animateTo]);

  // Report the settled height on mount and after a rotation, so the camera and
  // the dock start from the real number instead of guessing.
  useEffect(() => {
    onHeight(heights[snap]);
  }, [heights, snap, onHeight]);

  useEffect(() => {
    if (reduceMotion) {
      height.setValue(heights[snap]);
    }
  }, [reduceMotion, heights, snap, height]);

  const cycle = useCallback(() => {
    const index = ORDER.indexOf(snap);
    setSnap(ORDER[(index + 1) % ORDER.length] ?? 'peek');
  }, [snap, setSnap]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 6,
        onPanResponderGrant: () => {
          height.stopAnimation((value) => {
            dragStart.current = value;
            current.current = value;
          });
        },
        onPanResponderMove: (_event, gesture) => {
          const next = clamp(
            dragStart.current - gesture.dy,
            heightsRef.current.peek,
            heightsRef.current.full
          );
          current.current = next;
          height.setValue(next);
        },
        onPanResponderRelease: (_event, gesture) => {
          const nearest = ORDER.reduce((best, candidate) =>
            Math.abs(heightsRef.current[candidate] - current.current) <
            Math.abs(heightsRef.current[best] - current.current)
              ? candidate
              : best
          );
          let index = ORDER.indexOf(nearest);
          if (gesture.vy < -0.6) {
            index = Math.min(index + 1, ORDER.length - 1);
          } else if (gesture.vy > 0.6) {
            index = Math.max(index - 1, 0);
          }
          const target = ORDER[index] ?? 'peek';
          AccessibilityInfo.announceForAccessibility(
            target === 'peek'
              ? 'Route details collapsed. Map visible.'
              : target === 'half'
                ? 'Route details half open.'
                : 'Route details fully open.'
          );
          setSnap(target);
        },
        onPanResponderTerminate: () => {
          setSnap(snap);
        },
      }),
    [height, setSnap, snap]
  );

  const distance = formatDistance(trip.distance_km);
  const duration = formatDuration(trip.duration_min);
  const dispatched = formatDispatchAt(trip.dispatch_at);
  const emergency = formatEmergencyType(trip.emergency_type);
  const expanded = snap !== 'peek';

  // The response clock starts when the crew accepted, not when the sheet
  // mounted: reopening the app must not reset the number.
  const acceptedAt = useMemo(() => {
    const event = trip.timeline.find(
      (entry) => entry.kind === 'accepted' || entry.kind === 'en_route'
    );
    if (event === undefined) {
      return null;
    }
    const parsed = Date.parse(event.created_at);
    return Number.isNaN(parsed) ? null : parsed;
  }, [trip.timeline]);
  // Dispatch time is the fallback: a response that is already moving still
  // needs a clock, even if the server sent no acceptance event.
  const responseStartedAt = acceptedAt ?? Date.parse(trip.dispatch_at);
  const onTask = Number.isNaN(responseStartedAt)
    ? null
    : formatOnTask((nowMs ?? Date.now()) - responseStartedAt);

  return (
    <Animated.View style={[styles.wrap, { height }]}>
      <GlassSurface corner={radius.xxl} fill shadow="sheet" strong style={styles.glass} topOnly>
        <View style={[styles.column, { paddingBottom: insets.bottom + spacing.xs }]}>
          <View
            {...responder.panHandlers}
            onLayout={(event) => {
              const next = Math.round(event.nativeEvent.layout.height);
              setChrome((current) =>
                current.header === next ? current : { ...current, header: next }
              );
            }}
            style={styles.handleZone}
          >
            <Pressable
              accessibilityHint="Cycles between collapsed, half open and fully open."
              accessibilityLabel={expanded ? 'Collapse route details' : 'Expand route details'}
              accessibilityRole="button"
              onPress={cycle}
              style={styles.handleTap}
            >
              <View style={styles.grabber} />
            </Pressable>

            <View style={styles.head}>
              <StatusChip label={trip.status_label} status={trip.status} />
              {pending ? <SendingPill unconfirmed={unconfirmed} /> : null}
              <Text maxFontSizeMultiplier={1.2} style={[styles.reference, tabular]}>
                {trip.reference}
              </Text>
            </View>

            <Text maxFontSizeMultiplier={1.3} numberOfLines={2} style={styles.destination}>
              {trip.destination}
            </Text>

            <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={styles.sub}>
              {trip.origin}
              {dispatched === null ? '' : ` · ${dispatched}`}
              {onTask === null ? '' : ` · ${onTask} on task`}
            </Text>
          </View>

          <ScrollView
            contentContainerStyle={styles.body}
            scrollEnabled={expanded}
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
          >
            {banner === undefined ? null : banner}

            <ProgressRail status={trip.status} />

            {distance === null && duration === null ? null : (
              <View style={styles.stats}>
                {distance === null ? null : (
                  <View style={styles.stat}>
                    <Icon color={colors.secondary} name="nav" size={17} />
                    <Text maxFontSizeMultiplier={1.2} style={[styles.statValue, tabular]}>
                      {distance}
                    </Text>
                    <Text maxFontSizeMultiplier={1.2} style={styles.statLabel}>
                      to go
                    </Text>
                  </View>
                )}
                {duration === null ? null : (
                  <View style={styles.stat}>
                    <Icon color={colors.secondary} name="clock" size={17} />
                    <Text maxFontSizeMultiplier={1.2} style={[styles.statValue, tabular]}>
                      {duration}
                    </Text>
                    <Text maxFontSizeMultiplier={1.2} style={styles.statLabel}>
                      estimated
                    </Text>
                  </View>
                )}
              </View>
            )}

            {emergency === null ? null : (
              <Text maxFontSizeMultiplier={1.3} style={styles.emergency}>
                {emergency}
              </Text>
            )}

            {trip.instructions === null || trip.instructions.trim().length === 0 ? null : (
              <View style={styles.section}>
                <Text maxFontSizeMultiplier={1.2} style={styles.sectionLabel}>
                  Instructions
                </Text>
                <Text maxFontSizeMultiplier={1.3} style={styles.instructions}>
                  {trip.instructions}
                </Text>
              </View>
            )}

            <View style={styles.section}>
              <Text maxFontSizeMultiplier={1.2} style={styles.sectionLabel}>
                Timeline
              </Text>
              <Timeline events={trip.timeline} />
            </View>
          </ScrollView>

          <View
            onLayout={(event) => {
              const next = Math.round(event.nativeEvent.layout.height);
              setChrome((current) =>
                current.footer === next ? current : { ...current, footer: next }
              );
            }}
            style={styles.footer}
          >
            <TripActions
              showSecondary={expanded}
              trailing={
                <Pressable
                  accessibilityLabel={expanded ? 'Collapse details' : 'Expand details'}
                  accessibilityRole="button"
                  onPress={cycle}
                  style={({ pressed }) => [styles.expand, pressed && styles.expandPressed]}
                >
                  <Icon
                    color={colors.text}
                    name={expanded ? 'chevronDown' : 'chevronUp'}
                    size={22}
                  />
                </Pressable>
              }
              trip={trip}
            />
          </View>
        </View>
      </GlassSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
  },
  glass: {
    flex: 1,
  },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: contentMaxWidth + 80,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  handleZone: {
    // The drag lives here and nowhere else: the list below must keep scrolling.
    paddingBottom: spacing.xs,
  },
  handleTap: {
    alignSelf: 'center',
    minWidth: 72,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.32)',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  reference: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 20,
    letterSpacing: 0.5,
    fontWeight: weight.medium,
    marginStart: 'auto',
  },
  destination: {
    color: colors.text,
    fontSize: typeScale.section,
    lineHeight: 29,
    fontWeight: weight.medium,
    letterSpacing: -0.3,
    marginTop: spacing.sm,
  },
  sub: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    lineHeight: 20,
    marginTop: 3,
  },
  scroll: {
    flex: 1,
  },
  body: {
    paddingBottom: spacing.lg,
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.inset,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  statValue: {
    color: colors.text,
    fontSize: typeScale.meta,
    fontWeight: weight.strong,
  },
  statLabel: {
    color: colors.secondary,
    fontSize: typeScale.meta,
  },
  emergency: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    marginTop: spacing.md,
  },
  section: {
    marginTop: spacing.lg,
  },
  sectionLabel: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: weight.medium,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  instructions: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 25,
    backgroundColor: colors.inset,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: spacing.md,
  },
  footer: {
    paddingTop: spacing.sm,
  },
  expand: {
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.inset,
  },
  expandPressed: {
    backgroundColor: colors.raised,
  },
});
