// Configure the reachable backend origin when building; never bundle credentials.
export const API_ORIGIN = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');
export function apiUrl(path: string): string {
  if (!/^https?:\/\//.test(API_ORIGIN)) {
    throw new Error('Set EXPO_PUBLIC_API_URL to your backend origin before starting the app.');
  }
  return `${API_ORIGIN}${path}`;
}
