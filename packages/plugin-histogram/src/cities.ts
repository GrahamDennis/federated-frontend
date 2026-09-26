/**
 * Sample dataset: large world cities with approximate metro-area populations
 * (millions). Illustrative only — good enough to drive a demo, not a source.
 */
export interface City {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  population: number;
}

type Row = [id: string, name: string, country: string, lat: number, lon: number, population: number];

const ROWS: Row[] = [
  ['tokyo', 'Tokyo', 'JP', 35.69, 139.69, 37.1],
  ['osaka', 'Osaka', 'JP', 34.69, 135.5, 19.0],
  ['nagoya', 'Nagoya', 'JP', 35.18, 136.91, 9.5],
  ['seoul', 'Seoul', 'KR', 37.57, 126.98, 25.5],
  ['busan', 'Busan', 'KR', 35.18, 129.08, 3.4],
  ['shanghai', 'Shanghai', 'CN', 31.23, 121.47, 29.2],
  ['beijing', 'Beijing', 'CN', 39.9, 116.4, 21.8],
  ['guangzhou', 'Guangzhou', 'CN', 23.13, 113.26, 14.3],
  ['shenzhen', 'Shenzhen', 'CN', 22.54, 114.06, 13.1],
  ['hongkong', 'Hong Kong', 'HK', 22.32, 114.17, 7.5],
  ['taipei', 'Taipei', 'TW', 25.03, 121.57, 7.0],
  ['manila', 'Manila', 'PH', 14.6, 120.98, 14.4],
  ['jakarta', 'Jakarta', 'ID', -6.21, 106.85, 11.2],
  ['bangkok', 'Bangkok', 'TH', 13.76, 100.5, 11.2],
  ['hcmc', 'Ho Chi Minh City', 'VN', 10.82, 106.63, 9.3],
  ['singapore', 'Singapore', 'SG', 1.35, 103.82, 6.0],
  ['kualalumpur', 'Kuala Lumpur', 'MY', 3.14, 101.69, 8.4],
  ['delhi', 'Delhi', 'IN', 28.61, 77.21, 32.9],
  ['mumbai', 'Mumbai', 'IN', 19.08, 72.88, 21.3],
  ['kolkata', 'Kolkata', 'IN', 22.57, 88.36, 15.1],
  ['bengaluru', 'Bengaluru', 'IN', 12.97, 77.59, 13.6],
  ['dhaka', 'Dhaka', 'BD', 23.81, 90.41, 23.2],
  ['karachi', 'Karachi', 'PK', 24.86, 67.01, 17.2],
  ['tehran', 'Tehran', 'IR', 35.69, 51.39, 9.5],
  ['istanbul', 'Istanbul', 'TR', 41.01, 28.98, 15.8],
  ['cairo', 'Cairo', 'EG', 30.04, 31.24, 22.2],
  ['lagos', 'Lagos', 'NG', 6.52, 3.38, 15.9],
  ['kinshasa', 'Kinshasa', 'CD', -4.44, 15.27, 16.3],
  ['johannesburg', 'Johannesburg', 'ZA', -26.2, 28.05, 6.2],
  ['nairobi', 'Nairobi', 'KE', -1.29, 36.82, 5.3],
  ['moscow', 'Moscow', 'RU', 55.76, 37.62, 12.7],
  ['london', 'London', 'GB', 51.51, -0.13, 9.6],
  ['paris', 'Paris', 'FR', 48.86, 2.35, 11.2],
  ['madrid', 'Madrid', 'ES', 40.42, -3.7, 6.8],
  ['berlin', 'Berlin', 'DE', 52.52, 13.4, 3.6],
  ['rome', 'Rome', 'IT', 41.9, 12.5, 4.3],
  ['amsterdam', 'Amsterdam', 'NL', 52.37, 4.9, 1.2],
  ['stockholm', 'Stockholm', 'SE', 59.33, 18.07, 1.7],
  ['newyork', 'New York', 'US', 40.71, -74.0, 18.9],
  ['losangeles', 'Los Angeles', 'US', 34.05, -118.24, 12.5],
  ['chicago', 'Chicago', 'US', 41.88, -87.63, 8.9],
  ['houston', 'Houston', 'US', 29.76, -95.37, 6.4],
  ['toronto', 'Toronto', 'CA', 43.65, -79.38, 6.3],
  ['mexicocity', 'Mexico City', 'MX', 19.43, -99.13, 22.3],
  ['bogota', 'Bogotá', 'CO', 4.71, -74.07, 11.3],
  ['lima', 'Lima', 'PE', -12.05, -77.04, 11.0],
  ['saopaulo', 'São Paulo', 'BR', -23.55, -46.63, 22.6],
  ['rio', 'Rio de Janeiro', 'BR', -22.91, -43.17, 13.7],
  ['buenosaires', 'Buenos Aires', 'AR', -34.6, -58.38, 15.4],
  ['santiago', 'Santiago', 'CL', -33.45, -70.67, 6.9],
  ['sydney', 'Sydney', 'AU', -33.87, 151.21, 5.3],
  ['melbourne', 'Melbourne', 'AU', -37.81, 144.96, 5.1],
  ['perth', 'Perth', 'AU', -31.95, 115.86, 2.1],
  ['auckland', 'Auckland', 'NZ', -36.85, 174.76, 1.7],
];

export const CITIES: City[] = ROWS.map(([id, name, country, lat, lon, population]) => ({
  id,
  name,
  country,
  lat,
  lon,
  population,
}));
