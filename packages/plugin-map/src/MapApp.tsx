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

  const flyTo = useCallback(
    (place: Place) => {
      mapRef.current?.flyTo({
        center: place.center,
        zoom: place.zoom,
        essential: true,
      });
      setStatus(`Flying to ${place.name}`);
      void host?.toast(`🗺️ Flying to ${place.name}`, {tone: 'info'});
    },
    [host],
  );

  // When hosted, contribute fly-to commands to the host's command palette.
  useEffect(() => {
    if (!host) return;
    void host.setCommands(
      PLACES.map((place) => ({
        id: `map.fly.${place.id}`,
        title: `Map: Fly to ${place.name}`,
        subtitle: 'Pan the map to this city',
        run: () => flyTo(place),
      })),
    );
  }, [host, flyTo]);

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
            <button key={place.id} onClick={() => flyTo(place)}>
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
