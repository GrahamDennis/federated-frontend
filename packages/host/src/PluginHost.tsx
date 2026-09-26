import {useEffect, useRef, useState} from 'preact/hooks';
import {ThreadWindow} from '@quilted/threads';
import {
  RemoteRootRenderer,
  SignalRemoteReceiver,
} from '@remote-dom/preact/host';
import type {HostThread} from '@ff/protocol';
import {useChrome} from './chrome';
import {components} from './remoteComponents';

interface PluginHostProps {
  /**
   * This plugin instance (block). Several instances of one app can run side by
   * side, each with its own iframe, thread, commands and settings. The default
   * instance of an app uses the app id.
   */
  instanceId: string;
  appId: string;
  src: string;
  /**
   * Whether this plugin is in the foreground. The thread and iframe stay alive
   * regardless; this only gates whether the plugin's contributed component tree
   * (toolbar section, modal) is rendered into the chrome.
   */
  active: boolean;
}

export function PluginHost({instanceId, appId, src, active}: PluginHostProps) {
  const chrome = useChrome();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // One receiver per plugin: it stores the remote tree this plugin contributes.
  // The plugin (React) streams mutations into this Preact/signals receiver over
  // the framework-agnostic remote-dom connection.
  const [receiver] = useState(() => new SignalRemoteReceiver());

  // Keep the latest chrome callbacks without re-running the thread setup effect.
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Unsubscribe handles for context listeners this plugin registered, so they
    // can be dropped when the plugin unmounts (belt-and-suspenders alongside the
    // unsubscribe returned to the plugin).
    const contextUnsubscribes = new Set<() => void>();
    const track = (unsubscribe: () => void) => {
      contextUnsubscribes.add(unsubscribe);
      return () => {
        contextUnsubscribes.delete(unsubscribe);
        unsubscribe();
      };
    };

    const hostExports: HostThread = {
      connect: async () => receiver.connection,
      toast: async (message, options) =>
        chromeRef.current.toast(message, options),
      setCommands: async (commands) =>
        chromeRef.current.setCommandsForInstance(instanceId, commands),
      listApps: async () =>
        chromeRef.current.apps
          .filter((app) => app.id !== appId)
          .map((app) => ({id: app.id, name: app.name})),
      activateApp: async (appId) => chromeRef.current.activateApp(appId),
      forwardKeydown: async (event) =>
        chromeRef.current.handleForwardedShortcut(event),
      getContext: async () => chromeRef.current.getSharedContext(),
      setContext: async (patch) => chromeRef.current.setSharedContext(patch),
      subscribeContext: async (listener) =>
        track(chromeRef.current.subscribeSharedContext(listener)),
      getInstance: async () => chromeRef.current.getInstanceInfo(instanceId),
      getSettings: async () => chromeRef.current.getInstanceSettings(instanceId),
      subscribeSettings: async (listener) =>
        track(chromeRef.current.subscribeInstanceSettings(instanceId, listener)),
      publish: async (output, value) =>
        chromeRef.current.publishOutput(instanceId, output, value),
      getInputs: async () => chromeRef.current.getInstanceInputs(instanceId),
      subscribeInputs: async (listener) =>
        track(chromeRef.current.subscribeInstanceInputs(instanceId, listener)),
      runCommand: async (ref) => chromeRef.current.runCommandFor(instanceId, ref),
    };

    const thread = ThreadWindow.iframe<Record<string, never>, HostThread>(
      iframe,
      {
        targetOrigin: new URL(src).origin,
        exports: hostExports,
      },
    );

    return () => {
      thread.close();
      for (const unsubscribe of contextUnsubscribes) unsubscribe();
      chromeRef.current.setCommandsForInstance(instanceId, []);
    };
  }, [instanceId, src, receiver]);

  return (
    <>
      <div className="app-frame">
        <iframe
          ref={iframeRef}
          src={src}
          title={instanceId}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      {/*
        Renders the plugin's contributed remote tree. The toolbar-section and
        modal components portal themselves into the chrome, so nothing renders
        inline here — it's purely the bridge for the contributed UI.

        Only mounted while the plugin is in the foreground. When backgrounded the
        thread stays alive and keeps updating `receiver`; re-mounting on
        re-activation renders the receiver's current state, so contributions
        reappear without a reload.
      */}
      {active && (
        <RemoteRootRenderer receiver={receiver} components={components} />
      )}
    </>
  );
}
