import {createRoot} from 'react-dom/client';
import {App} from './App';
import './styles.css';

// NOTE: StrictMode intentionally omitted. Its dev-only double-invocation of
// effects would tear down and recreate the iframe/thread mid-handshake.
createRoot(document.getElementById('root')!).render(<App />);
