import {useEffect, useMemo, useRef, useState} from 'react';
import type {Host} from '@ff/plugin-sdk-react/connect';
import {useHostInputs, useHostSettings} from '@ff/plugin-sdk-react/settings';
import type {BBox, NumberRange, SelectedPlace} from '@ff/protocol';
import {CITIES, type City} from './cities';

/** Mirrors the defaults declared in `public/ff-plugin.json#settings`. */
const DEFAULT_SETTINGS = {title: 'Cities by population', maxRows: 8};

/** Population bins in millions (doubling, so the skewed data spreads out). */
const EDGES = [1, 2, 4, 8, 16, 32, 64];
const BINS = EDGES.slice(0, -1).map((min, i) => ({min, max: EDGES[i + 1]}));

function inBox(city: City, box: BBox): boolean {
  if (city.lat < box.south || city.lat > box.north) return false;
  // Map bounds can extend past ±180 when the world wraps; test every copy.
  if (box.east - box.west >= 360) return true;
  return [city.lon - 360, city.lon, city.lon + 360].some(
    (lon) => lon >= box.west && lon <= box.east,
  );
}

/**
 * A "selection view" block. It shows a population histogram of a sample city
 * dataset; brushing bars narrows the list of cities below, and picking a city
 * publishes it. Everything it talks to is wired by the layout author:
 *
 *  - input `viewport` (bbox): count only cities in this area (e.g. a map's);
 *  - output `range` (range): the brushed population range;
 *  - output `selection` (place): the picked city.
 *
 * Standalone (or unwired) it just works over the whole dataset.
 */
export function HistogramApp({host}: {host?: Host}) {
  const settings = useHostSettings(host, DEFAULT_SETTINGS);
  const inputs = useHostInputs(host);
  const viewport = inputs.viewport as BBox | null | undefined;
  const wired = 'viewport' in inputs;

  // Brushed bins, as an inclusive [from, to] index range.
  const [brush, setBrush] = useState<[number, number] | null>(null);
  const dragAnchor = useRef<number | null>(null);
  // Whether the brush was exactly one bin before the current press (so a plain
  // click on it toggles it off).
  const wasSingle = useRef(false);
  const [picked, setPicked] = useState<string | null>(null);

  const visible = useMemo(
    () => (viewport ? CITIES.filter((c) => inBox(c, viewport)) : CITIES),
    [viewport],
  );
  const counts = BINS.map(
    (bin) => visible.filter((c) => c.population >= bin.min && c.population < bin.max).length,
  );
  const tallest = Math.max(1, ...counts);

  const range: NumberRange | null = brush
    ? {min: BINS[brush[0]].min, max: BINS[brush[1]].max}
    : null;
  const listed = visible
    .filter((c) => !range || (c.population >= range.min && c.population < range.max))
    .sort((a, b) => b.population - a.population);

  // Publish the brushed range whenever it changes (keyed on a string so a new
  // but equal object doesn't re-publish).
  const rangeKey = range ? `${range.min}-${range.max}` : '';
  useEffect(() => {
    void host?.publish('range', range);
  }, [host, rangeKey]);

  function pick(city: City) {
    setPicked(city.id);
    const place: SelectedPlace = {
      id: city.id,
      name: city.name,
      latitude: city.lat,
      longitude: city.lon,
      zoom: 9,
    };
    void host?.publish('selection', place);
  }

  function startBrush(i: number) {
    dragAnchor.current = i;
    setBrush([i, i]);
  }
  function extendBrush(i: number) {
    const anchor = dragAnchor.current;
    if (anchor === null) return;
    setBrush([Math.min(anchor, i), Math.max(anchor, i)]);
  }
  function endBrush(i: number) {
    const anchor = dragAnchor.current;
    dragAnchor.current = null;
    // A plain click on the only brushed bin clears the brush.
    if (anchor === i && wasSingle.current) {
      setBrush(null);
    }
  }

  return (
    <div className="histogram">
      <header className="histogram-header">
        <h1>📊 {settings.title}</h1>
        <span className={`hist-badge ${host ? 'hosted' : ''}`}>
          {host ? 'hosted' : 'standalone'}
        </span>
        {wired && <span className="hist-badge wired">wired</span>}
      </header>
      <p className="histogram-scope">
        {wired
          ? viewport
            ? `${visible.length} of ${CITIES.length} cities in the connected area`
            : 'Waiting for an area from the connected block…'
          : `All ${CITIES.length} cities`}
        {range && ` · ${range.min}–${range.max}M people`}
      </p>

      <div
        className="bars"
        role="group"
        aria-label="Population histogram"
        onPointerLeave={() => (dragAnchor.current = null)}
      >
        {BINS.map((bin, i) => {
          const selected = brush !== null && i >= brush[0] && i <= brush[1];
          return (
            <button
              key={bin.min}
              className={`bar${selected ? ' selected' : ''}${brush && !selected ? ' dimmed' : ''}`}
              aria-label={`${bin.min} to ${bin.max} million: ${counts[i]} cities`}
              aria-pressed={selected}
              onPointerDown={() => {
                wasSingle.current = Boolean(brush && brush[0] === i && brush[1] === i);
                startBrush(i);
              }}
              onPointerEnter={() => extendBrush(i)}
              onPointerUp={() => endBrush(i)}
            >
              <span className="bar-count">{counts[i]}</span>
              <span
                className="bar-fill"
                style={{height: `${(counts[i] / tallest) * 100}%`}}
              />
              <span className="bar-label">
                {bin.min}–{bin.max}M
              </span>
            </button>
          );
        })}
      </div>

      <ol className="city-list" aria-label="Matching cities">
        {listed.slice(0, settings.maxRows).map((city) => (
          <li key={city.id}>
            <button
              className={city.id === picked ? 'picked' : ''}
              onClick={() => pick(city)}
            >
              <span>{city.name}</span>
              <span className="city-meta">
                {city.country} · {city.population}M
              </span>
            </button>
          </li>
        ))}
        {listed.length === 0 && <li className="city-empty">No cities match.</li>}
        {listed.length > settings.maxRows && (
          <li className="city-more">+{listed.length - settings.maxRows} more</li>
        )}
      </ol>
    </div>
  );
}
