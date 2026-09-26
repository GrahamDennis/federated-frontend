import {useCallback, useEffect, useRef, useState} from 'react';
import maplibregl from 'maplibre-gl';
import type {Host} from '@ff/plugin-sdk-react/connect';
import {useHostInputs, useHostSettings} from '@ff/plugin-sdk-react/settings';
import type {BBox, SelectedPlace} from '@ff/protocol';

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

/** Mirrors the defaults declared in `public/ff-plugin.json#settings`. */
const DEFAULT_SETTINGS = {
  title: 'World Map',
  home: 'world',
  followSelection: true,
  showCities: true,
  flyZoom: 9,
};

const WORLD_VIEW = {center: [10, 30] as [number, number], zoom: 1.4};

/** A rough bounding box for a camera, for when there's no live map to ask. */
function approxBounds(center: [number, number], zoom: number): BBox {
  const halfLon = Math.min(180, 360 / 2 ** zoom);
  const halfLat = Math.min(85, 170 / 2 ** zoom);
  return {
    west: center[0] - halfLon,
    east: center[0] + halfLon,
    south: Math.max(-85, center[1] - halfLat),
    north: Math.min(85, center[1] + halfLat),
  };
}

function toPlace(selected: SelectedPlace): Place {
  return {
    id: selected.id,
    name: selected.name,
    center: [selected.longitude, selected.latitude],
    zoom: selected.zoom ?? 9,
  };
}

function homeView(home: string) {
  const place = PLACES.find((p) => p.id === home);
  return place ? {center: place.center, zoom: place.zoom} : WORLD_VIEW;
}

/**
 * A MapLibre map. Its core (the map + city controls) works anywhere. When it's
 * hosted, it *enhances*: it registers ⌘K commands to fly to cities and raises a
 * host toast on arrival. Standalone, those host capabilities are simply absent
 * and the in-map panel + status line provide the same actions and feedback.
 */
export function MapApp({
  host,
}: {
  host?: Host;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [status, setStatus] = useState('Drag to explore, or jump to a city.');
  // Per-instance settings (the host can run several maps, each configured
  // differently — e.g. an overview that ignores the selection + a detail map).
  const settings = useHostSettings(host, DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Wired inputs (layout mode). A wired `focus` replaces following the shared
  // selection: the layout author has said exactly what this map should track.
  const inputs = useHostInputs(host);
  const focusWiredRef = useRef(false);
  focusWiredRef.current = 'focus' in inputs;
  const hostRef = useRef(host);
  hostRef.current = host;

  // Publish the visible area on the `viewport` output (e.g. to filter a
  // histogram). Without a live map, approximate it from the camera target.
  const publishViewport = useCallback((fallback?: {center: [number, number]; zoom: number}) => {
    let bbox: BBox | null = null;
    try {
      const b = mapRef.current?.getBounds();
      if (b) bbox = {west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth()};
    } catch {
      // The map can't report bounds until it has initialised; use the fallback.
    }
    if (!bbox && fallback) bbox = approxBounds(fallback.center, fallback.zoom);
    if (bbox) void hostRef.current?.publish('viewport', bbox);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    let map: maplibregl.Map | undefined;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        // MapLibre's free demo style — vector tiles, no API key required.
        style: 'https://demotiles.maplibre.org/style.json',
        ...homeView(settingsRef.current.home),
        attributionControl: {compact: true},
      });
      mapRef.current = map;
      map.on('moveend', () => publishViewport());
      map.on('load', () => publishViewport());
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

  // Publish an initial viewport once connected.
  useEffect(() => {
    if (host) publishViewport(homeView(settingsRef.current.home));
  }, [host, publishViewport]);

  // Jump to the configured starting view whenever it changes.
  useEffect(() => {
    lastFlownId.current = null;
    mapRef.current?.jumpTo(homeView(settings.home));
  }, [settings.home]);

  // Move the camera only (used both for local clicks and when the shared
  // selection changes elsewhere). Guarded by id so context echoes don't reanimate.
  const lastFlownId = useRef<string | null>(null);
  const flyCamera = useCallback((place: Place) => {
    if (lastFlownId.current === place.id) return;
    lastFlownId.current = place.id;
    const zoom = settingsRef.current.flyZoom;
    mapRef.current?.flyTo({center: place.center, zoom, essential: true, maxDuration: 2000});
    // Publish where we're heading straight away (the real bounds follow on
    // `moveend`, if the map is actually rendering).
    void hostRef.current?.publish('viewport', approxBounds(place.center, zoom));
    setStatus(`Flying to ${place.name}`);
  }, []);

  // A user selecting a city: move the camera, toast, and publish the selection
  // to the shared context so companion apps (e.g. Places) can react.
  const selectPlace = useCallback(
    (place: Place) => {
      flyCamera(place);
      void host?.toast(`🗺️ Flying to ${place.name}`, {tone: 'info'});
      const selectedPlace: SelectedPlace = {
        id: place.id,
        name: place.name,
        longitude: place.center[0],
        latitude: place.center[1],
        zoom: place.zoom,
      };
      void host?.setContext({selectedPlace});
      void host?.publish('selection', selectedPlace);
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

  // React to the shared selection changing elsewhere — e.g. a deep link seeding
  // the selection on load, Places clearing it, or another view selecting a place.
  // Fly from the selection's own coordinates so it works even for places not in
  // this map's catalog.
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      const apply = (selected: SelectedPlace | null | undefined) => {
        if (!selected || !settingsRef.current.followSelection) return;
        if (focusWiredRef.current) return;
        flyCamera(toPlace(selected));
      };
      const context = await host.getContext();
      if (!cancelled) apply(context.selectedPlace);
      const off = await host.subscribeContext((context) =>
        apply(context.selectedPlace),
      );
      if (cancelled) off();
      else unsubscribe = off;
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host, flyCamera]);

  // Follow a wired `focus` input.
  const focus = inputs.focus as SelectedPlace | null | undefined;
  useEffect(() => {
    if (focus) flyCamera(toPlace(focus));
  }, [focus, flyCamera]);

  return (
    <div className="map-app">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-panel">
        <div className="map-title">
          🗺️ {settings.title}
          <span className={`map-badge ${host ? 'hosted' : ''}`}>
            {host ? 'hosted' : 'standalone'}
          </span>
        </div>
        {settings.showCities && (
          <div className="map-buttons">
            {PLACES.map((place) => (
              <button key={place.id} onClick={() => selectPlace(place)}>
                {place.name}
              </button>
            ))}
          </div>
        )}
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
