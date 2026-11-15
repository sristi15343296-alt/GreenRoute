/**
 * Module stubs for the render tests.
 *
 * Each one replaces a native module that has no jest implementation. They are
 * stubs at the platform boundary only: no component logic is bypassed, and
 * nothing in `src/` is changed to accommodate them.
 *
 * Everything a factory needs is required inside the factory: jest forbids a
 * factory from closing over module-scope bindings.
 */

jest.mock('../../src/store', () => require('./store'));
jest.mock('../../src/a11y', () => require('./a11yMock'));
jest.mock('react-native-webview', () => require('./webviewMock'));
// The package ships its mock with every export under `default`.
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

// expo-blur and expo-linear-gradient are native-backed views; render plain ones.
jest.mock('expo-blur', () => {
  const react = require('react');
  const { View } = require('react-native');
  return { BlurView: (props: Record<string, unknown>) => react.createElement(View, props) };
});

jest.mock('expo-linear-gradient', () => {
  const react = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: (props: Record<string, unknown>) => react.createElement(View, props),
  };
});

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light' },
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));
jest.mock('expo-constants', () => ({ expoConfig: { version: '9.9.9' } }));
