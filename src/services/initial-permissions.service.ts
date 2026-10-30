import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Alert, Linking, Platform } from 'react-native';
import { bleMeshInstance } from './sos-trigger.service';

let pending: Promise<void> | undefined;
export function requestInitialPermissions(): Promise<void> {
  if (!pending) pending = request();
  return pending;
}
async function request(): Promise<void> {
  if (Platform.OS === 'web' || await AsyncStorage.getItem('@suraksha.permissions.v1')) return;
  const missing: string[] = [];
  try {
    if (!(await Location.requestForegroundPermissionsAsync()).granted) missing.push('Location');
  } catch { missing.push('Location'); }
  try { await bleMeshInstance.requestPermissions(); } catch { missing.push('Nearby devices / Bluetooth'); }
  try {
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('sos-alerts', {
      name: 'Nearby SOS alerts', importance: Notifications.AndroidImportance.HIGH,
    });
    if (!(await Notifications.requestPermissionsAsync()).granted) missing.push('Notifications');
  } catch { missing.push('Notifications'); }
  await AsyncStorage.setItem('@suraksha.permissions.v1', 'true');
  if (missing.length) Alert.alert('Permissions needed', missing.join(', ') + ' permission was not granted. Enable it in app settings for full SOS functionality.', [
    { text: 'Later', style: 'cancel' }, { text: 'Open settings', onPress: () => { void Linking.openSettings(); } },
  ]);
}
