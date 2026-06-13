import {useEffect, useRef, useState} from 'react';
import {ThreadWindow} from '@quilted/threads';
import {RemoteReceiver} from '@remote-dom/core/receivers';
import {RemoteRootRenderer} from '@remote-dom/react/host';
import type {HostThread} from '@ff/protocol';
import {useChrome} from './chrome';
import {components} from './remoteComponents';

interface PluginHostProps {
  pluginId: string;
  src: string;
  /**
   * Whether this plugin is in the foreground. The thread and iframe stay alive
   * regardless; this only gates whether the plugin's contributed component tree
   * (toolbar section, modal) is rendered into the chrome.
   */
  active: boolean;
}

export function PluginHost({pluginId, src, active}: PluginHostProps) {
  const chrome = useChrome();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // One receiver per plugin: it stores the remote tree this plugin contributes.
  const [receiver] = useState(() => new RemoteReceiver());

  // Keep the latest chrome callbacks without re-running the thread setup effect.
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const hostExports: HostThread = {
      connect: async () => receiver.connection,
      toast: async (message, options) =>
        chromeRef.current.toast(message, options),
      setCommands: async (commands) =>
        chromeRef.current.setCommandsForPlugin(pluginId, commands),
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
      chromeRef.current.setCommandsForPlugin(pluginId, []);
    };
  }, [pluginId, src, receiver]);

  return (
    <>
      <div className="app-frame">
        <iframe
          ref={iframeRef}
          src={src}
          title={pluginId}
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
