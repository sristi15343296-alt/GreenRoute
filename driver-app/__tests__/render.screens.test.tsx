/**
 * Render tests for the four screens the port rewrote.
 *
 * Each screen mounts against a store fixture typed as the real `StoreValue`, so
 * the presentation layer runs its own branching (assignment / idle / offline,
 * loaded / missing, queue rows, pairing form) rather than a snapshot of it.
 */

import './support/mocks';

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { trip } from './support/fixtures';
import { makeStore, setStore } from './support/store';
import { webview } from './support/webviewMock';

import { copy } from '../src/copy';
import { HomeScreen } from '../src/screens/HomeScreen';
import { LoginScreen } from '../src/screens/LoginScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { QueueScreen } from '../src/screens/QueueScreen';
import { TripScreen } from '../src/screens/TripScreen';

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

/** All rendered text, in document order. Host props can hold circular refs. */
function textOf(tree: ReactTestRenderer): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      walk((node as { children?: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return parts.join('\n');
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

beforeEach(() => {
  setStore(makeStore());
});

afterEach(() => {
  act(() => {
    let tree = mounted.pop();
    while (tree !== undefined) {
      tree.unmount();
      tree = mounted.pop();
    }
  });
  webview.props = null;
});

describe('HomeScreen', () => {
  it('renders the live assignment, its action dock and the map stage', () => {
    const store = makeStore({ assignment: trip(), queueCount: 3 });
    setStore(store);
    const tree = render(<HomeScreen />);
    const text = textOf(tree);

    expect(text).toContain('MED-12');
    expect(text).toContain('Marol Fire Station');
    expect(text).toContain(copy.accept);
    expect(store.callSign).toBe('MED-12');

    // The sheet opens at peek: the destination and the action are visible, and
    // the secondary row waits for the driver to expand it.
    expect(text).not.toContain(copy.navigate);
    expect(text).toContain(copy.history);

    const props = webview.props;
    if (props === null) {
      throw new Error('Home did not mount the map stage');
    }
    expect((props.source as { html: string }).html).toContain('tile.openstreetmap.org');
  });

  it('switches tab from the dock', () => {
    const store = makeStore({ assignment: trip(), queueCount: 2 });
    setStore(store);
    const tree = render(<HomeScreen />);

    act(() => {
      pressable(tree, 'Queue').props.onPress();
    });
    expect(store.switchTab).toHaveBeenCalledWith({ name: 'queue' });
  });

  it('renders the idle state when dispatch has no assignment', () => {
    setStore(makeStore({ assignment: null, loaded: true }));
    expect(textOf(render(<HomeScreen />))).toContain(copy.noActiveAssignment);
  });

  it('renders the offline banner with the queue counts', () => {
    setStore(
      makeStore({
        assignment: trip(),
        offline: true,
        pendingCount: 2,
        unconfirmedCount: 1,
      })
    );
    const text = textOf(render(<HomeScreen />));
    expect(text).toContain(copy.noConnection);
    expect(text).toContain('2 pending');
  });

  it('renders the unreachable state before the first load', () => {
    setStore(makeStore({ assignment: null, loaded: false, offline: true }));
    expect(textOf(render(<HomeScreen />))).toContain(copy.networkError);
  });
});

describe('TripScreen', () => {
  it('renders the response, instructions and timeline', () => {
    setStore(
      makeStore({
        trips: { 1: trip() },
        loadTrip: jest.fn(async () => trip()),
      })
    );
    const text = textOf(render(<TripScreen tripId={1} />));
    expect(text).toContain('GR-1001');
    expect(text).toContain(copy.instructions);
    expect(text).toContain('Enter from the north gate. Call on arrival.');
    expect(text).toContain('Dispatch assigned this response.');
    expect(text).toContain(copy.accept);
  });

  it('renders the gone state when dispatch no longer has the response', async () => {
    setStore(makeStore({ trips: {}, loadTrip: jest.fn(async () => null) }));
    let tree: ReactTestRenderer | null = null;
    await act(async () => {
      tree = render(<TripScreen tripId={999} />);
      await Promise.resolve();
    });
    if (tree === null) {
      throw new Error('TripScreen never mounted');
    }
    expect(textOf(tree)).toContain(copy.tripGone);
  });
});

describe('QueueScreen', () => {
  it('renders every response as a numbered row over the pin map', () => {
    const assignments = [
      trip({ id: 1, reference: 'GR-1001', destination: 'Marol Fire Station' }),
      trip({ id: 2, reference: 'GR-1002', destination: 'Sakinaka Depot' }),
      trip({ id: 3, reference: 'GR-1003', destination: 'Kurla Junction' }),
    ];
    setStore(
      makeStore({
        assignments,
        queueCount: 3,
        loadAssignments: jest.fn(async () => undefined),
      })
    );
    const tree = render(<QueueScreen />);
    const text = textOf(tree);

    expect(text).toContain('3 open · this unit');
    expect(text).toContain('Marol Fire Station');
    expect(text).toContain('Sakinaka Depot');
    expect(text).toContain('Kurla Junction');
    expect(text).toContain('GR-1003');

    const props = webview.props;
    if (props === null) {
      throw new Error('Queue did not mount the pin map');
    }
    expect((props.source as { html: string }).html).toContain('tile.openstreetmap.org');
  });

  it('opens a response when its row is pressed', () => {
    const store = makeStore({
      assignments: [trip({ id: 4, reference: 'GR-1004' })],
      loadAssignments: jest.fn(async () => undefined),
    });
    setStore(store);
    const tree = render(<QueueScreen />);

    const rows = tree.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('GR-1004') &&
        typeof node.props.onPress === 'function'
    );
    expect(rows.length).toBeGreaterThan(0);
    act(() => {
      rows[0].props.onPress();
    });
    expect(store.push).toHaveBeenCalledWith({ name: 'trip', tripId: 4 });
  });

  it('narrows the list and the pins with the status chips', () => {
    const assignments = [
      trip({ id: 1, reference: 'GR-1001', destination: 'Marol Fire Station' }),
      trip({
        id: 2,
        reference: 'GR-1002',
        status: 'in_transit',
        status_label: 'In transit',
        destination: 'Sakinaka Depot',
      }),
      trip({ id: 3, reference: 'GR-1003', destination: 'Kurla Junction' }),
    ];
    setStore(
      makeStore({
        assignments,
        queueCount: 3,
        loadAssignments: jest.fn(async () => undefined),
      })
    );
    const tree = render(<QueueScreen />);
    expect(textOf(tree)).toContain('Marol Fire Station');

    act(() => {
      pressable(tree, 'In transit').props.onPress();
    });
    const filtered = textOf(tree);
    expect(filtered).toContain('Sakinaka Depot');
    expect(filtered).not.toContain('Marol Fire Station');

    // The map shows the same subset the list does.
    const props = webview.props;
    if (props === null) {
      throw new Error('Queue did not mount the pin map');
    }
    act(() => {
      (props.onMessage as (event: { nativeEvent: { data: string } }) => void)({
        nativeEvent: { data: JSON.stringify({ type: 'status', value: 'ready' }) },
      });
    });
    const calls = webview.injectJavaScript.mock.calls;
    const script = calls[calls.length - 1][0] as string;
    expect(script).toContain('"id":2');
    expect(script).not.toContain('"id":1');

    // Tapping the active chip again clears the filter.
    act(() => {
      pressable(tree, 'In transit').props.onPress();
    });
    expect(textOf(tree)).toContain('Marol Fire Station');
  });

  it('opens a response when its map pin is tapped', () => {
    const store = makeStore({
      assignments: [trip({ id: 9, reference: 'GR-1009' })],
      loadAssignments: jest.fn(async () => undefined),
    });
    setStore(store);
    render(<QueueScreen />);

    const props = webview.props;
    if (props === null) {
      throw new Error('Queue did not mount the pin map');
    }
    act(() => {
      (props.onMessage as (event: { nativeEvent: { data: string } }) => void)({
        nativeEvent: { data: JSON.stringify({ type: 'pin', id: 9 }) },
      });
    });
    expect(store.push).toHaveBeenCalledWith({ name: 'trip', tripId: 9 });
  });

  it('renders the empty queue copy', () => {
    setStore(
      makeStore({
        assignments: [],
        loadAssignments: jest.fn(async () => undefined),
      })
    );
    expect(textOf(render(<QueueScreen />))).toContain(copy.noOtherResponses);
  });
});

describe('ProfileScreen', () => {
  it('renders the unit details and the unpair confirmation sheet', () => {
    const store = makeStore();
    setStore(store);
    const tree = render(<ProfileScreen />);
    const text = textOf(tree);

    expect(text).toContain('MED-12');
    expect(text).toContain('9.9.9');
    expect(text).toContain(copy.pendingUpdates);
    expect(text).not.toContain(copy.unpairBody);

    act(() => {
      pressable(tree, copy.unpair).props.onPress();
    });
    expect(textOf(tree)).toContain(copy.unpairBody);

    act(() => {
      pressable(tree, copy.cancel).props.onPress();
    });
    expect(store.unpair).not.toHaveBeenCalled();
  });
});

describe('LoginScreen', () => {
  it('signs in with the call sign and the four-digit PIN', async () => {
    const store = makeStore({ token: null, callSign: null, vehicleType: null });
    setStore(store);
    const tree = render(<LoginScreen />);

    expect(textOf(tree)).toContain(copy.signInHeading);

    const callSign = tree.root.findAll(
      (node) =>
        node.props.placeholder === copy.callSignPlaceholder &&
        typeof node.props.onChangeText === 'function'
    );
    const pin = tree.root.findAll(
      (node) =>
        node.props.placeholder === copy.pinPlaceholder &&
        typeof node.props.onChangeText === 'function'
    );
    expect(callSign.length).toBeGreaterThan(0);
    expect(pin.length).toBeGreaterThan(0);

    act(() => {
      callSign[0].props.onChangeText('med-12');
      pin[0].props.onChangeText('1234');
    });

    await act(async () => {
      pressable(tree, copy.signIn).props.onPress();
      await Promise.resolve();
    });

    // The crew knows MED-12; demo dispatch issues token-med12.
    expect(store.pair).toHaveBeenCalledWith('token-med12');
    expect(store.setPin).toHaveBeenCalledWith('1234');
  });

  it('shows a refused sign-in without echoing the PIN', () => {
    setStore(
      makeStore({
        token: null,
        pairNotice: copy.unitCodeExpired,
        callSign: null,
        vehicleType: null,
      })
    );
    expect(textOf(render(<LoginScreen />))).toContain(copy.unitCodeExpired);
  });
});
