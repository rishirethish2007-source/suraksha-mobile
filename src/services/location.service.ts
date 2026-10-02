/**
 * @fileoverview Location service to acquire high accuracy GPS coordinates.
 */

import Geolocation from 'react-native-geolocation-service';
import { PermissionsAndroid, Platform } from 'react-native';
import { SOSLocation } from '../interfaces/sos.types';

export class LocationService {
  /**
   * Request permissions and fetch current location.
   * In a disaster scenario, GPS can take time. We wait up to 15 seconds for a high accuracy fix.
   * If it times out, we attempt to retrieve the last known location.
   */
  public static async getCurrentLocation(): Promise<SOSLocation> {
    const hasPermission = await this.requestLocationPermission();
    
    if (!hasPermission) {
      throw new Error('Location permission denied. Cannot capture precise location.');
    }

    return new Promise((resolve, reject) => {
      // First try to get a high-accuracy GPS fix.
      Geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            altitude: position.coords.altitude || undefined,
            accuracy: position.coords.accuracy,
            heading: position.coords.heading || undefined,
            speed: position.coords.speed || undefined,
            provider: 'gps' // Assuming gps due to high accuracy request
          });
        },
        (error) => {
          // If high-accuracy times out or fails, try last known location fallback
          this.getLastKnownLocation()
            .then(resolve)
            .catch(() => reject(error));
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 10000, // Accept fixes up to 10 seconds old
        }
      );
    });
  }

  /**
   * Attempt to get the last known location quickly if GPS is unavailable.
   */
  private static async getLastKnownLocation(): Promise<SOSLocation> {
    return new Promise((resolve, reject) => {
      Geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            provider: 'last_known'
          });
        },
        (error) => reject(error),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 600000 } // 10 minutes max age
      );
    });
  }

  /**
   * Check and request location permissions based on the platform.
   */
  private static async requestLocationPermission(): Promise<boolean> {
    if (Platform.OS === 'ios') {
      const auth = await Geolocation.requestAuthorization('whenInUse');
      return auth === 'granted';
    }

    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Location Permission',
          message: 'Suraksha needs to access your precise location for emergency alerts.',
          buttonNeutral: 'Ask Me Later',
          buttonNegative: 'Cancel',
          buttonPositive: 'OK',
        }
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }

    return false;
  }
}
