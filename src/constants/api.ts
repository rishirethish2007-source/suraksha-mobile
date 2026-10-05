import AsyncStorage from '@react-native-async-storage/async-storage';
export let API_ORIGIN = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');
const KEY = '@suraksha.backend.origin.v1';
let initialization: Promise<void> | undefined;
export function normalizeOrigin(value: string): string {
  const raw = value.trim();
  let url: URL;
  try { url = new URL(raw.includes('://') ? raw : `http://${raw}`); }
  catch { throw new Error('Enter a server address such as http://172.18.66.69:8000'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Enter only the backend origin, without a path, password or query.');
  if (url.protocol !== 'https:' && process.env.EXPO_PUBLIC_ALLOW_INSECURE_HTTP !== 'true')
    throw new Error('This build requires an HTTPS backend.');
  return url.origin;
}
export function loadApiSettings(): Promise<void> {
  if (!initialization) initialization = (async () => {
    const saved = await AsyncStorage.getItem(KEY);
    if (saved) API_ORIGIN = normalizeOrigin(saved);
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}
// Call only after checking the server authority in BackendSettings.
export async function saveApiOrigin(origin: string): Promise<void> {
  await loadApiSettings();
  const value = normalizeOrigin(origin);
  await AsyncStorage.setItem(KEY, value); API_ORIGIN = value;
}
export function apiUrl(path: string): string {
  if (!API_ORIGIN) throw new Error('Set the backend address in Settings first.');
  return `${normalizeOrigin(API_ORIGIN)}${path}`;
}
