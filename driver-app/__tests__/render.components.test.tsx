/**
 * Render tests for the presentation layer.
 *
 * These mount every ported component, so a crash, an invalid style array or a
 * missing token fails here instead of on a phone. Native boundaries are stubbed
 * in `./support/mocks` — no component logic is bypassed.
 */

import './support/mocks';

import React from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { setReduceMotion, setReduceTransparency } from './support/a11yMock';
import { event, trip } from './support/fixtures';
import { webview } from './support/webviewMock';

import { AssignmentFooter } from '../src/components/AssignmentFooter';
import { EmptyState } from '../src/components/EmptyState';
import { GlassPill, GlassSurface } from '../src/components/Glass';
import { Icon, type IconName } from '../src/components/Icon';
import { MapStage } from '../src/components/MapStage';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { PrimaryAction } from '../src/components/PrimaryAction';
import { ProgressRail } from '../src/components/ProgressRail';
import { SecondaryButton } from '../src/components/SecondaryButton';
import { SendingPill } from '../src/components/SendingPill';
import { Sheet } from '../src/components/Sheet';
import { SkeletonRows } from '../src/components/Skeleton';
import { StatusChip } from '../src/components/StatusChip';
import { Timeline } from '../src/components/Timeline';
import { TopBar, TopBarAction } from '../src/components/TopBar';
import { TripSummary } from '../src/components/TripSummary';
import { copy } from '../src/copy';
import { colors, glass, size } from '../src/theme';

const mounted: ReactTestRenderer[] = [];

function render(element: React.ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer | null = null;
  act(() => {
    tree = create(<SafeAreaProvider>{element}</SafeAreaProvider>);
  });
  if (tree === null) {
    throw new Error('render produced no tree');
  }
  mounted.push(tree);
  return tree;
}

function dump(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

function flatStyles(tree: ReactTestRenderer): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const node of tree.root.findAll((candidate) => typeof candidate.type === 'string')) {
    const flat = StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>);
    if (flat !== undefined) {
      found.push(flat as unknown as Record<string, unknown>);
    }
  }
  return found;
}

function pressable(tree: ReactTestRenderer, label: string) {
  const matches = tree.root.findAll(
    (node) =>
      node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
  );
  if (matches.length === 0) {
    throw new Error(`no pressable labelled "${label}"`);
  }
  return matches[0];
}

afterEach(() => {
  act(() => {
    let tree = mounted.pop();
    while (tree !== undefined) {
      tree.unmount();
      tree = mounted.pop();
    }
  });
  setReduceTransparency(false);
  setReduceMotion(false);
  webview.props = null;
});

describe('Glass', () => {
  it('paints the material with the 0.35 rim', () => {
    const tree = render(
      <GlassSurface corner={20} style={{ padding: 12 }}>
        <Text>glass content</Text>
      </GlassSurface>
    );
    expect(dump(tree)).toContain('glass content');
    expect(flatStyles(tree).some((style) => style.borderColor === colors.rim)).toBe(true);
  });

  it('renders GlassPill and the sheet variant', () => {
    const pill = render(
      <GlassPill>
        <Text>pill</Text>
      </GlassPill>
    );
    expect(dump(pill)).toContain('pill');

    const sheet = render(
      <GlassSurface shadow="sheet" strong topOnly>
        <Text>sheet surface</Text>
      </GlassSurface>
    );
    const styles = flatStyles(sheet);
    expect(dump(sheet)).toContain('sheet surface');
    expect(styles.some((style) => style.borderTopLeftRadius !== undefined)).toBe(true);
  });

  it('collapses to an opaque fill and keeps the rim under reduce-transparency', () => {
    setReduceTransparency(true);
    const tree = render(
      <GlassSurface>
        <Text>opaque</Text>
      </GlassSurface>
    );
    const styles = flatStyles(tree);
    expect(
      styles.some(
        (style) => style.backgroundColor === glass.opaque && style.borderColor === colors.rim
      )
    ).toBe(true);
  });
});

describe('Icon', () => {
  const names: IconName[] = [
    'nav',
    'alert',
    'plus',
    'gear',
    'layers',
    'locate',
    'mute',
    'clock',
    'pin',
    'turnRight',
    'straight',
    'check',
    'user',
    'ambulance',
    'chevronLeft',
    'chevronRight',
    'signal',
    'wifi',
    'battery',
  ];

  it('draws every symbol in the set, never the fallback', () => {
    for (const name of names) {
      const tree = render(<Icon name={name} size={22} />);
      const drawn = JSON.stringify(tree.toJSON());
      // Every symbol draws at least one SVG shape (paths, rects, circles).
      expect(drawn).toContain('RNSVG');
      // The switch's default branch is a single straight line: if a name ever
      // falls through to it, that symbol is missing from the set.
      expect(drawn).not.toContain('"d":"M4 12h16"');
    }
  });
});

describe('Status chips and rails', () => {
  it('labels the status chip for screen readers and text', () => {
    const tree = render(<StatusChip label="In transit" status="in_transit" />);
    expect(dump(tree)).toContain('In transit');
    expect(
      tree.root.findAll(
        (node) => node.props.accessibilityLabel === 'Status: In transit'
      ).length
    ).toBeGreaterThan(0);
  });

  it('fills the rail up to the current status', () => {
    const tree = render(<ProgressRail status="in_transit" />);
    expect(flatStyles(tree).filter((style) => style.height === size.rail).length).toBe(4);
  });

  it('hides the rail for a cancelled response', () => {
    const tree = render(<ProgressRail status="cancelled" />);
    expect(tree.toJSON()).toBeNull();
  });
});

describe('Sending, skeleton, offline and empty states', () => {
  it('shows the retrying copy only when a send already left the device', () => {
    expect(dump(render(<SendingPill unconfirmed />))).toContain(copy.sendingRetry);
  });

  it('renders skeleton rows without motion', () => {
    const tree = render(<SkeletonRows count={2} />);
    expect(dump(tree)).toContain('Loading');
  });

  it('reports the pending count and last update', () => {
    const text = dump(
      render(<OfflineBanner lastUpdated={null} pendingCount={2} unconfirmedCount={1} />)
    );
    expect(text).toContain(copy.noConnection);
    expect(text).toContain('2 pending');
    expect(text).toContain(copy.deliveryUnconfirmed);
  });

  it('renders an empty state with its action', () => {
    const text = dump(
      render(
        <EmptyState
          action={<SecondaryButton icon="clock" label={copy.refresh} onPress={() => undefined} />}
          title={copy.noActiveAssignment}
        />
      )
    );
    expect(text).toContain(copy.noActiveAssignment);
    expect(text).toContain(copy.refresh);
  });
});

describe('TopBar', () => {
  it('renders identity, caption and a counted action', () => {
    const onBack = jest.fn();
    const tree = render(
      <TopBar
        actions={
          <>
            <TopBarAction badge={3} icon="layers" label="Other responses" onPress={() => undefined} />
            <TopBarAction icon="gear" label={copy.settings} onPress={() => undefined} />
          </>
        }
        caption="ALS ambulance"
        onBack={onBack}
        title="MED-12"
      />
    );
    const text = dump(tree);
    expect(text).toContain('MED-12');
    expect(text).toContain('ALS ambulance');
    expect(text).toContain('3');
    expect(text).toContain('Other responses, 3');

    act(() => {
      pressable(tree, 'Back').props.onPress();
    });
    expect(onBack).toHaveBeenCalled();
  });
});

describe('Sheet', () => {
  it('renders its content and closes from the scrim', () => {
    const onClose = jest.fn();
    const tree = render(
      <Sheet
        footer={<PrimaryAction label={copy.complete} onPress={() => undefined} />}
        onClose={onClose}
        title={copy.reportIssueTitle}
        visible
      >
        <Text>{copy.reportIssueHint}</Text>
      </Sheet>
    );
    const text = dump(tree);
    expect(text).toContain(copy.reportIssueTitle);
    expect(text).toContain(copy.reportIssueHint);
    expect(text).toContain(copy.complete);

    act(() => {
      pressable(tree, copy.close).props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('TripSummary and Timeline', () => {
  it('renders the assignment with its stats and pending pill', () => {
    const tree = render(<TripSummary pending trip={trip()} unconfirmed={false} />);
    const text = dump(tree);
    expect(text).toContain('Marol Fire Station');
    expect(text).toContain('8.4 km');
    expect(text).toContain('21 min');
    expect(text).toContain('Critical');
    expect(text).toContain(copy.sending);
  });

  it('renders timeline entries newest first', () => {
    const tree = render(
      <Timeline
        events={[event('accepted', 'Response accepted.'), event('departed', 'Left the station.')]}
      />
    );
    const text = dump(tree);
    expect(text).toContain('Response accepted.');
    expect(text).toContain('Left the station.');
    expect(text.indexOf('Left the station.')).toBeLessThan(text.indexOf('Response accepted.'));
  });

  it('renders the empty timeline copy', () => {
    expect(dump(render(<Timeline events={[]} />))).toContain(copy.noTimeline);
  });
});

describe('AssignmentFooter', () => {
  it('renders the dock and opens the issue sheet from it', () => {
    const tree = render(<AssignmentFooter trip={trip()} />);
    const text = dump(tree);
    expect(text).toContain(copy.accept);
    expect(text).toContain(copy.navigate);
    expect(text).toContain(copy.reportIssue);
    expect(text).toContain(copy.requestBackup);
    expect(text).not.toContain(copy.reportIssueHint);

    act(() => {
      pressable(tree, copy.reportIssue).props.onPress();
    });
    expect(dump(tree)).toContain(copy.reportIssueHint);
  });
});

describe('MapStage', () => {
  it('renders the route document and injects the payload on ready', () => {
    render(<MapStage trip={trip()} />);

    const props = webview.props;
    if (props === null) {
      throw new Error('the map never mounted its WebView');
    }
    const source = props.source as { html: string };
    expect(source.html).toContain('tile.openstreetmap.org');
    expect(source.html).toContain('leaflet');

    act(() => {
      (props.onMessage as (event: { nativeEvent: { data: string } }) => void)({
        nativeEvent: { data: JSON.stringify({ type: 'status', value: 'ready' }) },
      });
    });

    const calls = webview.injectJavaScript.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const script = calls[calls.length - 1][0] as string;
    expect(script).toContain('window.__render');
    expect(script).toContain('19.1136');
    expect(script).toContain('"mode":"route"');
  });

  it('reports a tapped queue pin, which is what opens the response', () => {
    const onSelectTrip = jest.fn();
    render(
      <MapStage
        mode="pins"
        onSelectTrip={onSelectTrip}
        trip={null}
        trips={[
          trip({ id: 11, destination: 'Marol Fire Station' }),
          trip({ id: 12, destination: 'Sakinaka Depot' }),
        ]}
      />
    );

    const props = webview.props;
    if (props === null) {
      throw new Error('the queue map never mounted its WebView');
    }
    const source = props.source as { html: string };
    expect(source.html).toContain('tile.openstreetmap.org');

    act(() => {
      (props.onMessage as (event: { nativeEvent: { data: string } }) => void)({
        nativeEvent: { data: JSON.stringify({ type: 'pin', id: 12 }) },
      });
    });
    expect(onSelectTrip).toHaveBeenCalledWith(12);

    act(() => {
      (props.onMessage as (event: { nativeEvent: { data: string } }) => void)({
        nativeEvent: { data: JSON.stringify({ type: 'status', value: 'ready' }) },
      });
    });
    const calls = webview.injectJavaScript.mock.calls;
    const script = calls[calls.length - 1][0] as string;
    expect(script).toContain('"mode":"pins"');
    expect(script).toContain('"index":2');
  });

  it('ignores a malformed message instead of crashing', () => {
    const onSelectTrip = jest.fn();
    render(<MapStage onSelectTrip={onSelectTrip} trip={trip()} />);
    const props = webview.props;
    if (props === null) {
      throw new Error('the map never mounted its WebView');
    }
    act(() => {
      (props.onMessage as (event: { nativeEvent: { data: string } }) => void)({
        nativeEvent: { data: 'not json' },
      });
    });
    expect(onSelectTrip).not.toHaveBeenCalled();
  });

  it('falls back honestly when offline, and when tiles never load', () => {
    expect(dump(render(<MapStage offline trip={trip()} />))).toContain(
      'Map unavailable offline'
    );

    const tree = render(<MapStage trip={trip()} />);
    const props = webview.props;
    if (props === null) {
      throw new Error('the map never mounted its WebView');
    }
    act(() => {
      (props.onMessage as (event: { nativeEvent: { data: string } }) => void)({
        nativeEvent: { data: JSON.stringify({ type: 'status', value: 'tiles' }) },
      });
    });
    expect(dump(tree)).toContain('Map could not load');
  });

  it('stays a quiet surface when there is nothing to draw', () => {
    const tree = render(<MapStage trip={null} />);
    expect(tree.root.findAllByProps({ testID: 'map-stage' }).length).toBe(0);
  });
});
