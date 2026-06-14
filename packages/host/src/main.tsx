// Activates @preact/signals' Preact integration (patches Preact so component
// renders track signal reads). @remote-dom/preact's renderer reads the receiver's
// signals, so without this the remote tree renders once, empty, and never updates.
import '@preact/signals';
import {render} from 'preact';
import {App} from './App';
import './styles.css';

// The host runs on Preact (the plugins are React 19) — they interoperate purely
// through the framework-agnostic remote-dom connection.
render(<App />, document.getElementById('root')!);
