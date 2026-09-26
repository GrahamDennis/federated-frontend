import {createRoot} from 'react-dom/client';
import {connectToHost} from '@ff/plugin-sdk-react/connect';
import {forwardKeyboardShortcuts} from '@ff/protocol';
import {ActionsApp} from './ActionsApp';
import './styles.css';

async function boot() {
  const connected = await connectToHost();
  if (connected) forwardKeyboardShortcuts(connected.host);
  createRoot(document.getElementById('root')!).render(
    <ActionsApp host={connected?.host} />,
  );
}

void boot();
