import {useEffect, useState} from 'react';
import type {ThreadImports} from '@quilted/threads';
import type {HostThread, SelectedPlace} from '@ff/protocol';

/**
 * A subordinate "detail" companion. It doesn't own a primary view — it reflects
 * and annotates whatever place is selected in the shared workspace context
 * (published by the map). This is the spoke in the hub-and-spokes pattern: the
 * value comes from being composed *beside* the map and bound to the same data.
 */
export function PlacesApp({host}: {host?: ThreadImports<HostThread>}) {
  const [selected, setSelected] = useState<SelectedPlace | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  // Reflect the shared selection.
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const context = await host.getContext();
      if (!cancelled) setSelected(context.selectedPlace ?? null);
      const off = await host.subscribeContext((context) =>
        setSelected(context.selectedPlace ?? null),
      );
      if (cancelled) off();
      else unsubscribe = off;
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host]);

  // Contribute a command to clear the selection (host palette).
  useEffect(() => {
    if (!host) return;
    void host.setCommands([
      {
        id: 'places.clear',
        title: 'Places: Clear selection',
        subtitle: 'Deselect the current place',
        run: () => void host.setContext({selectedPlace: null}),
      },
    ]);
    return () => void host.setCommands([]);
  }, [host]);

  return (
    <div className="places">
      <div className="places-header">
        <h1>📍 Places</h1>
        <span className={`places-badge ${host ? 'hosted' : ''}`}>
          {host ? 'detail' : 'standalone'}
        </span>
      </div>

      {selected ? (
        <div className="place-detail">
          <h2>{selected.name}</h2>
          <dl className="place-coords">
            <div>
              <dt>Latitude</dt>
              <dd>{selected.latitude.toFixed(3)}</dd>
            </div>
            <div>
              <dt>Longitude</dt>
              <dd>{selected.longitude.toFixed(3)}</dd>
            </div>
          </dl>
          <label className="notes-field">
            <span>Notes</span>
            <textarea
              value={notes[selected.id] ?? ''}
              onChange={(e) =>
                setNotes((current) => ({
                  ...current,
                  [selected.id]: e.target.value,
                }))
              }
              placeholder={`Jot a note about ${selected.name}…`}
            />
          </label>
          {host && (
            <button
              className="clear-btn"
              onClick={() => void host.setContext({selectedPlace: null})}
            >
              Clear selection
            </button>
          )}
        </div>
      ) : (
        <p className="places-empty">
          {host
            ? 'No place selected. Pick a city in the map and its details appear here.'
            : 'Running standalone — there is no shared selection. Dock this panel beside the map to reflect what it selects.'}
        </p>
      )}
    </div>
  );
}
