import {useCallback, useEffect, useRef, useState} from 'react';
import maplibregl from 'maplibre-gl';
import type {ThreadImports} from '@quilted/threads';
import type {HostThread} from '@ff/protocol';

interface Place {
  id: string;
  name: string;
  center: [number, number];
  zoom: number;
}

const PLACES: Place[] = [
  {id: 'tokyo', name: 'Tokyo', center: [139.69, 35.69], zoom: 9},
  {id: 'newyork', name: 'New York', center: [-74.0, 40.71], zoom: 9},
  {id: 'london', name: 'London', center: [-0.13, 51.51], zoom: 9},
  {id: 'sydney', name: 'Sydney', center: [151.21, -33.87], zoom: 9},
  {id: 'cairo', name: 'Cairo', center: [31.24, 30.04], zoom: 9},
];

/**
 * A MapLibre map. Its core (the map + city controls) works anywhere. When it's
 * hosted, it *enhances*: it registers ⌘K commands to fly to cities and raises a
 * host toast on arrival. Standalone, those host capabilities are simply absent
 * and the in-map panel + status line provide the same actions and feedback.
 */
export function MapApp({
  host,
}: {
  host?: ThreadImports<HostThread>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [status, setStatus] = useState('Drag to explore, or jump to a city.');

  useEffect(() => {
    if (!containerRef.current) return;
    let map: maplibregl.Map | undefined;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        // MapLibre's free demo style — vector tiles, no API key required.
        style: 'https://demotiles.maplibre.org/style.json',
        center: [10, 30],
        zoom: 1.4,
        attributionControl: {compact: true},
      });
      mapRef.current = map;
    } catch (error) {
      // e.g. WebGL unavailable. The panel/controls still work (camera no-ops).
      setStatus('Map canvas unavailable in this environment.');
      console.warn('MapLibre init failed:', error);
    }
    return () => {
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Move the camera only (used both for local clicks and when the shared
  // selection changes elsewhere). Guarded by id so context echoes don't reanimate.
  const lastFlownId = useRef<string | null>(null);
  const flyCamera = useCallback((place: Place) => {
    if (lastFlownId.current === place.id) return;
    lastFlownId.current = place.id;
    mapRef.current?.flyTo({
      center: place.center,
      zoom: place.zoom,
      essential: true,
    });
    setStatus(`Flying to ${place.name}`);
  }, []);

  // A user selecting a city: move the camera, toast, and publish the selection
  // to the shared context so companion apps (e.g. Places) can react.
  const selectPlace = useCallback(
    (place: Place) => {
      flyCamera(place);
      void host?.toast(`🗺️ Flying to ${place.name}`, {tone: 'info'});
      void host?.setContext({
        selectedPlace: {
          id: place.id,
          name: place.name,
          longitude: place.center[0],
          latitude: place.center[1],
          zoom: place.zoom,
        },
      });
    },
    [host, flyCamera],
  );

  // When hosted, contribute fly-to commands to the host's command palette.
  useEffect(() => {
    if (!host) return;
    void host.setCommands(
      PLACES.map((place) => ({
        id: `map.fly.${place.id}`,
        title: `Map: Fly to ${place.name}`,
        subtitle: 'Pan the map to this city',
        run: () => selectPlace(place),
      })),
    );
    return () => void host.setCommands([]);
  }, [host, selectPlace]);

  // React to the shared selection changing elsewhere (e.g. Places clearing it,
  // or — in a fuller app — another view selecting a place): move the camera.
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      const apply = (placeId: string | null | undefined) => {
        const place = PLACES.find((p) => p.id === placeId);
        if (place) flyCamera(place);
      };
      const context = await host.getContext();
      if (!cancelled) apply(context.selectedPlace?.id);
      const off = await host.subscribeContext((context) =>
        apply(context.selectedPlace?.id),
      );
      if (cancelled) off();
      else unsubscribe = off;
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host, flyCamera]);

  return (
    <div className="map-app">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-panel">
        <div className="map-title">
          🗺️ World Map
          <span className={`map-badge ${host ? 'hosted' : ''}`}>
            {host ? 'hosted' : 'standalone'}
          </span>
        </div>
        <div className="map-buttons">
          {PLACES.map((place) => (
            <button key={place.id} onClick={() => selectPlace(place)}>
              {place.name}
            </button>
          ))}
        </div>
        <div className="map-status">{status}</div>
        {!host && (
          <div className="map-note">
            Standalone — load this inside the host to also get ⌘K commands and
            chrome toasts.
          </div>
        )}
      </div>
    </div>
  );
}
