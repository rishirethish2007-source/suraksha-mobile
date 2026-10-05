import * as SecureStore from 'expo-secure-store';
import { normalizeOrigin, saveApiOrigin } from '../constants/api';
import { timedFetch } from './timed-fetch';

export async function checkAndSaveBackend(value: string): Promise<string> {
  const origin = normalizeOrigin(value);
  // Never send saved credentials to a candidate address during discovery.
  const response = await timedFetch(`${origin}/api/v1/identity/authority`);
  if (!response.ok) throw new Error('Server check failed. Update/start the backend and configure its device authority.');
  const data = await response.json();
  if (typeof data.ca_public_key !== 'string' || !/^04[0-9a-f]{128}$/.test(data.ca_public_key)) throw new Error('This is not a configured Suraksha backend.');
  const known = await SecureStore.getItemAsync('suraksha.device.ca.v2');
  if (known && known !== data.ca_public_key) throw new Error('This server has a different identity. Use the original backend; changing to another organisation requires a fresh app setup.');
  await saveApiOrigin(origin);
  return origin;
}
