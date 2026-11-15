/**
 * Accessibility helpers: reduced motion, status announcements, and the single
 * place a status change is spoken.
 */

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) {
        setReduceMotion(enabled);
      }
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

/**
 * Reduce Transparency. When on, every glass surface collapses to an opaque
 * fill instead of blurring what is behind it.
 */
export function useReduceTransparency(): boolean {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((enabled) => {
      if (mounted) {
        setReduceTransparency(enabled);
      }
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setReduceTransparency
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceTransparency;
}

export interface Announcement {
  label: string;
  text: string;
}

/**
 * Announce a change once, when it happens. Android uses the chip's live region,
 * iOS needs an explicit announcement.
 */
export function useAnnouncements(announcements: Announcement[]): void {
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const current = announcements.map((entry) => `${entry.label}:${entry.text}`).join('|');
    if (previous.current !== null && previous.current !== current && Platform.OS === 'ios') {
      const changed = announcements.find(
        (entry) => !previous.current?.includes(`${entry.label}:${entry.text}`)
      );
      if (changed !== undefined) {
        AccessibilityInfo.announceForAccessibility(`${changed.label}: ${changed.text}`);
      }
    }
    previous.current = current;
  }, [announcements]);
}
