/**
 * The map stage.
 *
 * A WebView running Leaflet, behind one component so the provider is an
 * implementation detail. Nothing outside this file knows it is a WebView.
 *
 * Tiles come from the network, so when the unit is offline — or the tiles fail
 * to load — this renders an explicit fallback instead of a fake map. Never
 * pretend the driver has a map they do not have.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView as RawWebView, type WebViewProps } from 'react-native-webview';

import { useReduceMotion } from '../a11y';
import { copy } from '../copy';
import { buildMapDocument, type MapPayload, type MapPin } from '../mapHtml';
import { colors, mapSurface, type as typeScale, weight } from '../theme';
import type { Trip } from '../types';
import { Icon } from './Icon';

/**
 * react-native-webview@14 declares its export as `WebView<P = undefined>`, which
 * intersects the props with `undefined` and collapses them to `never`. Re-typing
 * it against the documented props keeps the component usable without an `any`.
 */
const WebView = RawWebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<React.ComponentRef<typeof RawWebView>> }
>;

type MapMode = 'route' | 'pins';

interface MapStageProps {
  trip: Trip | null;
  trips?: Trip[];
  mode?: MapMode;
  offline?: boolean;
  onSelectTrip?: (tripId: number) => void;
  /** Rendered under the map when it cannot be drawn. */
  fallbackLabel?: string;
  /**
   * Pixels of the stage bottom that a sheet or bar covers. The camera frames
   * the route above this line instead of behind it.
   */
  bottomInset?: number;
}

function coordinates(trip: Trip, which: 'origin' | 'destination'): [number, number] | null {
  const lat = which === 'origin' ? trip.origin_lat : trip.destination_lat;
  const lng = which === 'origin' ? trip.origin_lng : trip.destination_lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return [lat, lng];
}

/**
 * A straight origin → destination leg, used only when dispatch has stored no
 * geometry. It is deliberately two points: drawing a curve would claim road
 * knowledge the phone does not have. The sheet says which one is shown.
 */
function legBetween(from: [number, number], to: [number, number]): Array<[number, number]> {
  return [from, to];
}

/** Geometry the server resolved, if it is usable. */
function storedRoute(trip: Trip | null): Array<[number, number]> | null {
  const raw = trip?.route;
  if (!Array.isArray(raw) || raw.length < 2) {
    return null;
  }
  const points: Array<[number, number]> = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length !== 2) {
      return null;
    }
    const [lat, lng] = point;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return null;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }
    points.push([lat, lng]);
  }
  return points;
}

export function MapStage({
  trip,
  trips = [],
  mode = 'route',
  offline = false,
  onSelectTrip,
  fallbackLabel,
  bottomInset = 0,
}: MapStageProps): React.JSX.Element {
  const webViewRef = useRef<React.ComponentRef<typeof RawWebView> | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const reduceMotion = useReduceMotion();

  const html = useMemo(() => buildMapDocument(), []);

  const payload = useMemo<MapPayload>(() => {
    if (mode === 'pins') {
      const pins: MapPin[] = [];
      trips.forEach((entry, index) => {
        const point = coordinates(entry, 'destination');
        if (point === null) {
          return;
        }
        pins.push({
          id: entry.id,
          lat: point[0],
          lng: point[1],
          label: entry.destination,
          tone: colors.accent,
          index: index + 1,
        });
      });
      return {
        mode: 'pins',
        route: [],
        origin: null,
        destination: null,
        pins,
        reduceMotion,
        bottomInset,
      };
    }

    const origin = trip === null ? null : coordinates(trip, 'origin');
    const destination = trip === null ? null : coordinates(trip, 'destination');
    // Prefer the road dispatch resolved. The straight leg is a fallback, not the
    // default: the admin has had real geometry all along and the crew did not.
    const resolved = storedRoute(trip);
    const route =
      resolved ??
      (origin !== null && destination !== null ? legBetween(origin, destination) : []);
    return {
      mode: 'route',
      route,
      origin,
      destination,
      pins: [],
      reduceMotion,
      bottomInset,
    };
  }, [mode, trip, trips, reduceMotion, bottomInset]);

  const payloadKey = JSON.stringify(payload);

  const inject = useCallback(() => {
    const script = `window.__render && window.__render(${payloadKey}); true;`;
    webViewRef.current?.injectJavaScript(script);
  }, [payloadKey]);

  // Every payload change has to reach the document. Without this the stage drew
  // its first frame and never re-framed, so opening the sheet left the
  // destination behind it.
  useEffect(() => {
    if (!ready) {
      return;
    }
    inject();
    // A payload that lands while the document is still parsing is dropped by the
    // WebView; one delayed retry is cheaper than a handshake protocol.
    const timer = setTimeout(inject, 400);
    return () => clearTimeout(timer);
  }, [ready, inject]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      const message = parsed as { type?: string; value?: string; id?: number };
      // The document posts one shape: { type: 'status', value } where value is
      // 'ready', 'offline' or 'tiles'. A 'ready' that never matched here left the
      // opaque loading layer covering the map forever.
      if (message.type === 'status' && (message.value === 'offline' || message.value === 'tiles')) {
        setFailed(true);
      }
      if (message.type === 'status' && message.value === 'ready') {
        setFailed(false);
        setReady(true);
        inject();
      }
      if (message.type === 'pin' && typeof message.id === 'number') {
        onSelectTrip?.(message.id);
      }
    },
    [inject, onSelectTrip]
  );

  const hasGeometry = payload.route.length > 0 || payload.pins.length > 0;
  // A response can arrive with no coordinates at all — GR-2024 does. The stage
  // used to render an empty surface in that case, which reads as a broken map.
  const missingCoordinates =
    mode === 'route' && trip !== null && payload.route.length === 0;

  // If neither a ready nor an offline message arrives (a hanging tile CDN, for
  // instance) the opaque loading layer would cover the stage forever.
  useEffect(() => {
    if (ready || failed) {
      return;
    }
    const timer = setTimeout(() => setFailed(true), 6000);
    return () => clearTimeout(timer);
  }, [ready, failed]);

  if (offline || failed || missingCoordinates) {
    const title = offline
      ? 'Map unavailable offline'
      : missingCoordinates
        ? 'No map for this response'
        : 'Map could not load';
    return (
      <View style={styles.fallback}>
        <View style={styles.fallbackIcon}>
          <Icon color={colors.secondary} name="pin" size={26} />
        </View>
        <Text maxFontSizeMultiplier={1.3} style={styles.fallbackTitle}>
          {title}
        </Text>
        <Text maxFontSizeMultiplier={1.3} style={styles.fallbackBody}>
          {fallbackLabel ??
            (missingCoordinates
              ? copy.noCoordinates
              : trip === null
                ? 'Route details are shown below.'
                : `${trip.origin} to ${trip.destination}`)}
        </Text>
      </View>
    );
  }

  // Nothing to draw yet (no assignment): the stage stays a quiet surface and the
  // screen's own empty state explains it, rather than claiming a map failed.
  if (!hasGeometry) {
    return <View style={styles.root} />;
  }

  return (
    <View style={styles.root} pointerEvents="box-none">
      <WebView
        ref={webViewRef}
        source={{ html }}
        originWhitelist={['*']}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        cacheEnabled
        onMessage={handleMessage}
        onError={() => {
          setFailed(true);
        }}
        onHttpError={() => {
          setFailed(true);
        }}
        onLoadEnd={inject}
        testID="map-stage"
      />
      {ready ? null : <View style={styles.loading} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: mapSurface,
  },
  web: {
    flex: 1,
    backgroundColor: mapSurface,
  },
  loading: {
    position: 'absolute',
    top: 0,
    start: 0,
    end: 0,
    bottom: 0,
    backgroundColor: mapSurface,
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 120,
    backgroundColor: mapSurface,
  },
  fallbackIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  fallbackTitle: {
    color: colors.text,
    fontSize: typeScale.secondary,
    fontWeight: weight.medium,
    textAlign: 'center',
  },
  fallbackBody: {
    color: colors.secondary,
    fontSize: typeScale.meta,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 22,
  },
});
