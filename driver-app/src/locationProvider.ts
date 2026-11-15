/**
 * The only module that touches `expo-location`.
 *
 * Kept apart from `location.ts` so the tracker's rules stay testable without a
 * native module, and so the platform-specific parts are visible in one place.
 *
 * Platform limits, stated plainly because they shape what dispatch can promise:
 *
 * - **Foreground only.** Updates run while the app is in the foreground. When the
 *   app is backgrounded, tracking pauses and the badge says so. There is no
 *   background task, so a driver who switches apps (or a phone that suspends the
 *   app) stops reporting until they come back.
 * - **No tracking after force-quit.** Neither Android nor iOS will restart a
 *   killed app for location. A crew that force-stops the app is invisible until
 *   it is opened again; the admin sees STALE/LOST, never a cancelled emergency.
 * - **Android** additionally throttles background and doze-mode updates, and
 *   location is only delivered if the driver granted "while using the app".
 * - **iOS** shows the blue status indicator while location is in use; a driver
 *   who chooses "Allow Once" loses sharing after the app is closed.
 */

import * as Location from 'expo-location';

import {
  UPDATE_DISTANCE_M,
  UPDATE_INTERVAL_MS,
  type GeolocationSample,
} from './location';

export interface WatchHandle {
  remove: () => void;
}

export async function requestLocationPermission(): Promise<boolean> {
  try {
    const existing = await Location.getForegroundPermissionsAsync();
    if (existing.granted) {
      // A stale "denied" answer after a settings change is common on Android;
      // asking again is cheap and never opens a second prompt when granted.
      return true;
    }
    if (!existing.canAskAgain) {
      return false;
    }
    const asked = await Location.requestForegroundPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

export async function watchLocation(
  onSample: (sample: GeolocationSample) => void
): Promise<WatchHandle> {
  const subscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      timeInterval: UPDATE_INTERVAL_MS,
      distanceInterval: UPDATE_DISTANCE_M,
      mayShowUserSettingsDialog: true,
    },
    (position) => {
      onSample({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy ?? null,
        heading:
          position.coords.heading === null || Number.isNaN(position.coords.heading)
            ? null
            : position.coords.heading,
        speed:
          position.coords.speed === null || Number.isNaN(position.coords.speed)
            ? null
            : position.coords.speed,
        timestamp: position.timestamp,
      });
    }
  );
  return {
    remove: () => {
      subscription.remove();
    },
  };
}
