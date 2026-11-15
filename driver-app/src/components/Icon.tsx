/**
 * The icon set. Drawn as SVG paths so they stay crisp at any size and pick up
 * `currentColor` from the `color` prop. Icons are always paired with a text
 * label in a critical path; never the only carrier of meaning.
 */

import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '../theme';

export type IconName =
  | 'nav'
  | 'alert'
  | 'plus'
  | 'gear'
  | 'layers'
  | 'locate'
  | 'mute'
  | 'clock'
  | 'pin'
  | 'turnRight'
  | 'straight'
  | 'check'
  | 'user'
  | 'ambulance'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronUp'
  | 'chevronDown'
  | 'home'
  | 'history'
  | 'checkSquare'
  | 'shield'
  | 'close'
  | 'pause'
  | 'fingerprint'
  | 'signal'
  | 'wifi'
  | 'battery';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

export function Icon({ name, size = 20, color = colors.text }: IconProps): React.JSX.Element {
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      {render(name, color)}
    </Svg>
  );
}

function render(name: IconName, color: string): React.JSX.Element {
  const stroke = { stroke: color, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  switch (name) {
    case 'nav':
      return <Path d="M12 3.2 20 20.4l-8-3.6-8 3.6L12 3.2Z" fill={color} />;
    case 'alert':
      return (
        <>
          <Path d="M12 4.5 21 20H3L12 4.5Z" fill="none" stroke={color} strokeLinejoin="round" strokeWidth={1.8} />
          <Path d="M12 10v4.2" stroke={color} strokeLinecap="round" strokeWidth={1.9} />
          <Circle cx={12} cy={17} fill={color} r={1.05} />
        </>
      );
    case 'plus':
      return <Path d="M12 5v14M5 12h14" stroke={color} strokeLinecap="round" strokeWidth={2} />;
    case 'gear':
      return (
        <>
          <Circle cx={12} cy={12} fill="none" r={3.1} stroke={color} strokeWidth={1.8} />
          <Path
            d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"
            stroke={color}
            strokeLinecap="round"
            strokeWidth={1.7}
          />
        </>
      );
    case 'layers':
      return (
        <>
          <Path d="M12 3.6 3.4 8.2 12 12.8l8.6-4.6L12 3.6Z" fill="none" stroke={color} strokeLinejoin="round" strokeWidth={1.7} />
          <Path d="M3.4 15.8 12 20.4l8.6-4.6" fill="none" stroke={color} strokeLinejoin="round" strokeWidth={1.7} />
        </>
      );
    case 'locate':
      return (
        <>
          <Circle cx={12} cy={12} fill="none" r={6.2} stroke={color} strokeWidth={1.8} />
          <Circle cx={12} cy={12} fill={color} r={2.1} />
          <Path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3" stroke={color} strokeLinecap="round" strokeWidth={1.7} />
        </>
      );
    case 'mute':
      return (
        <>
          <Path d="M11 5.5 6.8 9H3.2v6h3.6L11 18.5V5.5Z" fill="none" stroke={color} strokeLinejoin="round" strokeWidth={1.7} />
          <Path d="M15.4 9.4 20 14M20 9.4 15.4 14" stroke={color} strokeLinecap="round" strokeWidth={1.8} />
        </>
      );
    case 'clock':
      return (
        <>
          <Circle cx={12} cy={12} fill="none" r={8} stroke={color} strokeWidth={1.8} />
          <Path d="M12 7.6V12l3.2 2" stroke={color} strokeLinecap="round" strokeWidth={1.8} />
        </>
      );
    case 'pin':
      return (
        <>
          <Path
            d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"
            fill="none"
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={1.8}
          />
          <Circle cx={12} cy={10} fill={color} r={2.4} />
        </>
      );
    case 'turnRight':
      return (
        <>
          <Path d="M7 20V11a4 4 0 0 1 4-4h6" fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} />
          <Path d="M14 3.6 17.6 7 14 10.4" fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} />
        </>
      );
    case 'straight':
      return (
        <>
          <Path d="M12 20V5" stroke={color} strokeLinecap="round" strokeWidth={2.2} />
          <Path d="M7.6 9.2 12 4.8l4.4 4.4" fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} />
        </>
      );
    case 'check':
      return <Path d="M4.8 12.6 9.6 17.4 19.2 6.6" fill="none" {...stroke} strokeWidth={2.3} />;
    case 'user':
      return (
        <>
          <Circle cx={12} cy={8.4} fill="none" r={3.6} stroke={color} strokeWidth={1.8} />
          <Path d="M4.8 20c.6-3.6 3.6-5.4 7.2-5.4s6.6 1.8 7.2 5.4" fill="none" stroke={color} strokeLinecap="round" strokeWidth={1.8} />
        </>
      );
    case 'ambulance':
      return (
        <>
          <Path
            d="M3 16V9.5A1.5 1.5 0 0 1 4.5 8h8.2l3.1 3.2H20a1.5 1.5 0 0 1 1.5 1.5V16"
            fill="none"
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={1.7}
          />
          <Circle cx={7.4} cy={17.4} fill="none" r={1.9} stroke={color} strokeWidth={1.7} />
          <Circle cx={17.2} cy={17.4} fill="none" r={1.9} stroke={color} strokeWidth={1.7} />
          <Path d="M12.4 10.2v3.2M10.8 11.8h3.2" stroke={color} strokeLinecap="round" strokeWidth={1.6} />
        </>
      );
    case 'chevronLeft':
      return <Path d="M14.5 6 8.5 12l6 6" fill="none" {...stroke} strokeWidth={2.1} />;
    case 'chevronRight':
      return <Path d="M9.5 6l6 6-6 6" fill="none" {...stroke} strokeWidth={2.1} />;
    case 'chevronUp':
      return <Path d="M6 14.6 12 8.6l6 6" fill="none" {...stroke} strokeWidth={2.1} />;
    case 'chevronDown':
      return <Path d="M6 9.4 12 15.4l6-6" fill="none" {...stroke} strokeWidth={2.1} />;
    case 'home':
      return (
        <>
          <Path
            d="M4 10.4 12 4l8 6.4V19a1.6 1.6 0 0 1-1.6 1.6H15v-6H9v6H5.6A1.6 1.6 0 0 1 4 19v-8.6Z"
            fill="none"
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={1.8}
          />
        </>
      );
    case 'history':
      return (
        <>
          <Path
            d="M3.6 12a8.4 8.4 0 1 0 2.9-6.3"
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeWidth={1.8}
          />
          <Path d="M3.2 3.6v4.6h4.6" fill="none" {...stroke} strokeWidth={1.8} />
          <Path d="M12 7.8V12l3.1 2" fill="none" {...stroke} strokeWidth={1.8} />
        </>
      );
    case 'checkSquare':
      return (
        <>
          <Rect
            fill="none"
            height={17}
            rx={4.4}
            stroke={color}
            strokeWidth={1.8}
            width={17}
            x={3.5}
            y={3.5}
          />
          <Path d="M8 12.2 10.8 15 16.2 9" fill="none" {...stroke} strokeWidth={2} />
        </>
      );
    case 'shield':
      return (
        <Path
          d="M12 3.4 20 6.2v5.6c0 4.2-3.3 7.6-8 8.8-4.7-1.2-8-4.6-8-8.8V6.2L12 3.4Z"
          fill="none"
          stroke={color}
          strokeLinejoin="round"
          strokeWidth={1.8}
        />
      );
    case 'close':
      return <Path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" fill="none" {...stroke} strokeWidth={2} />;
    case 'pause':
      return <Path d="M9.4 6v12M14.6 6v12" fill="none" {...stroke} strokeWidth={2.2} />;
    case 'fingerprint':
      return (
        <>
          <Path
            d="M5.4 11a6.6 6.6 0 0 1 13.2 0v2.2c0 2.4-.5 4.5-1.4 6.1"
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeWidth={1.7}
          />
          <Path
            d="M8.6 11a3.4 3.4 0 0 1 6.8 0v2.8c0 2.2-.4 4.2-1.2 5.8"
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeWidth={1.7}
          />
          <Path
            d="M11.9 11v3.6c0 1.6-.3 3.1-.9 4.4"
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeWidth={1.7}
          />
        </>
      );
    case 'signal':
      return (
        <>
          <Rect fill={color} height={4.2} rx={1} width={3.2} x={1} y={15.5} />
          <Rect fill={color} height={6.8} rx={1} width={3.2} x={6} y={12.9} />
          <Rect fill={color} height={9.8} rx={1} width={3.2} x={11} y={9.9} />
          <Rect fill={color} height={12.8} opacity={0.4} rx={1} width={3.2} x={16} y={6.9} />
        </>
      );
    case 'wifi':
      return (
        <>
          <Path d="M2.2 9a14 14 0 0 1 19.6 0" fill="none" stroke={color} strokeLinecap="round" strokeWidth={1.9} />
          <Path d="M5.6 12.6a9 9 0 0 1 12.8 0" fill="none" stroke={color} strokeLinecap="round" strokeWidth={1.9} />
          <Circle cx={12} cy={16.6} fill={color} r={1.7} />
        </>
      );
    case 'battery':
      return (
        <>
          <Rect fill="none" height={11.6} opacity={0.55} rx={3.4} stroke={color} strokeWidth={1.4} width={19} x={1.2} y={6.2} />
          <Rect fill={color} height={7.8} rx={2} width={13} x={3.4} y={8.1} />
          <Path d="M21.8 10.4v3.2" stroke={color} strokeLinecap="round" strokeOpacity={0.55} strokeWidth={1.8} />
        </>
      );
    default:
      return <Path d="M4 12h16" stroke={color} strokeWidth={2} />;
  }
}
