/**
 * Map handoff. The app never renders a map or reads GPS; it opens the platform's
 * map app with the destination the server sent.
 */

import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { hasCoordinates, type Trip } from './types';

export function mapsUrl(trip: Trip): string | null {
  if (!hasCoordinates(trip)) {
    return null;
  }
  const lat = trip.destination_lat;
  const lng = trip.destination_lng;
  if (lat === null || lng === null) {
    return null;
  }
  const coordinates = `${lat},${lng}`;
  const label = encodeURIComponent(trip.destination);
  if (Platform.OS === 'ios') {
    return `maps://?daddr=${coordinates}&dirflg=d&q=${label}`;
  }
  return `google.navigation:q=${coordinates}&mode=d`;
}

function webMapsUrl(trip: Trip): string | null {
  if (!hasCoordinates(trip) || trip.destination_lat === null || trip.destination_lng === null) {
    return null;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${trip.destination_lat},${trip.destination_lng}`;
}

export type MapsOutcome = 'opened' | 'failed' | 'unavailable';

export async function openMaps(trip: Trip): Promise<MapsOutcome> {
  const native = mapsUrl(trip);
  if (native === null) {
    return 'unavailable';
  }
  try {
    await Linking.openURL(native);
    return 'opened';
  } catch {
    const web = webMapsUrl(trip);
    if (web === null) {
      return 'unavailable';
    }
    try {
      await Linking.openURL(web);
      return 'opened';
    } catch {
      return 'failed';
    }
  }
}
