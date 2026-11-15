/**
 * A progress ring: track plus accent arc, starting at twelve o'clock.
 * Used by Duty (elapsed shift) and the vehicle check (items done).
 */

import React from 'react';
import Svg, { Circle } from 'react-native-svg';

import { colors } from '../theme';

interface RingProps {
  /** 0 to 1. Clamped. */
  progress: number;
  size: number;
  thickness: number;
  color?: string;
  track?: string;
}

export function Ring({
  progress,
  size,
  thickness,
  color = colors.accent,
  track = 'rgba(255,255,255,0.10)',
}: RingProps): React.JSX.Element {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.min(Math.max(progress, 0), 1);
  return (
    <Svg height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
      <Circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        stroke={track}
        strokeWidth={thickness}
      />
      <Circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        rotation={-90}
        stroke={color}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - filled)}
        strokeLinecap="round"
        strokeWidth={thickness}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}
