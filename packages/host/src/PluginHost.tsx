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
}

export function PluginHost({pluginId, src}: PluginHostProps) {
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
    <section className="plugin">
      <div className="plugin-titlebar">
        <span className="plugin-dot" />
        <span className="plugin-name">{pluginId}</span>
        <span className="plugin-origin">{new URL(src).origin}</span>
        <span className="plugin-badge">sandboxed iframe</span>
      </div>
      <div className="plugin-frame">
        <iframe
          ref={iframeRef}
          src={src}
          title={pluginId}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      {/*
        Renders the plugin's contributed remote tree. The toolbar-section and
        modal components portal themselves into the chrome, so nothing of this
        renders inline here — it's purely the bridge for the contributed UI.
      */}
      <RemoteRootRenderer receiver={receiver} components={components} />
    </section>
  );
}
