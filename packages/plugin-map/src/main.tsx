import {createRoot} from 'react-dom/client';
import {connectToHost} from '@ff/plugin-sdk-react/connect';
import {forwardKeyboardShortcuts} from '@ff/protocol';
import 'maplibre-gl/dist/maplibre-gl.css';
import {MapApp} from './MapApp';
import './styles.css';

async function boot() {
  const connected = await connectToHost();
  if (connected) forwardKeyboardShortcuts(connected.host);
  createRoot(document.getElementById('root')!).render(
    <MapApp host={connected?.host} />,
  );
}

void boot();
