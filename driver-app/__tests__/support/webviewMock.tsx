/**
 * Test-only stand-in for react-native-webview.
 *
 * The real WebView is a native view: it has no jest implementation and would
 * either fail to render or silently swallow the message contract this app
 * depends on. This stub keeps the same imperative handle and prop surface so
 * MapStage's postMessage wiring can be driven for real.
 */

import React from 'react';
import { View } from 'react-native';

export interface WebViewStubState {
  props: Record<string, unknown> | null;
  injectJavaScript: jest.Mock;
}

export const webview: WebViewStubState = {
  props: null,
  injectJavaScript: jest.fn(),
};

interface StubProps {
  testID?: string;
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
  source?: { html?: string };
  [key: string]: unknown;
}

export class WebView extends React.Component<StubProps> {
  injectJavaScript = jest.fn();

  componentDidMount(): void {
    webview.injectJavaScript = this.injectJavaScript;
  }

  componentDidUpdate(): void {
    webview.injectJavaScript = this.injectJavaScript;
  }

  render(): React.JSX.Element {
    webview.props = this.props as Record<string, unknown>;
    return <View testID={this.props.testID ?? 'webview-stub'} />;
  }
}

export default WebView;
