import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';
const subscribe = () => () => {};
const client = () => true;
const server = () => false;
export function useColorScheme() {
  const hydrated = useSyncExternalStore(subscribe, client, server);
  const scheme = useRNColorScheme();
  return hydrated ? scheme : 'light';
}
