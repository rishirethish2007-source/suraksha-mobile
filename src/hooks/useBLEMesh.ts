/**
 * @fileoverview Custom hook for managing BLE mesh scanning, background relay, and processing nearby SOS.
 */

import { useState, useEffect, useCallback } from 'react';
import { bleMeshInstance } from '../services/sos-trigger.service';
import { LocationService } from '../services/location.service';
import { NetworkService } from '../services/network.service';
import { SOSApiService } from '../services/sos-api.service';
import { SOSPayload, ActiveSOSEvent, SOSLocation } from '../interfaces/sos.types';

export function useBLEMesh(selfDeviceId: string) {
  const [isScanning, setIsScanning] = useState(false);
  const [nearbySOSEvents, setNearbySOSEvents] = useState<ActiveSOSEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selfLocation, setSelfLocation] = useState<SOSLocation | undefined>(undefined);

  // Periodically update self location for relay context
  useEffect(() => {
    const updateLocation = async () => {
      try {
        const loc = await LocationService.getCurrentLocation();
        setSelfLocation(loc);
      } catch (e) {
        // Silent fail on background location update
      }
    };
    updateLocation();
    const interval = setInterval(updateLocation, 60000); // Every minute
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleSOSReceived = async (payload: SOSPayload) => {
      let distanceMeters: number | undefined;
      if (selfLocation && payload.location) {
        distanceMeters = bleMeshInstance.calculateDistance(
          selfLocation.latitude,
          selfLocation.longitude,
          payload.location.latitude,
          payload.location.longitude
        );
      }

      const activeEvent: ActiveSOSEvent = { ...payload, distanceMeters };
      
      setNearbySOSEvents(prev => {
        // Prevent duplicate display
        if (prev.some(e => e.sosId === payload.sosId)) return prev;
        return [...prev, activeEvent];
      });

      // Relay Logic
      const { isOnline } = await NetworkService.checkConnectivity();
      if (isOnline) {
        try {
          // If online, upload to server directly
          await SOSApiService.sendSOS(payload);
        } catch (e) {
          // If server upload fails, fallback to relay
          bleMeshInstance.relayPayload(payload, selfDeviceId, selfLocation);
        }
      } else {
        // Offline, relay via BLE mesh
        bleMeshInstance.relayPayload(payload, selfDeviceId, selfLocation);
      }
    };

    const handleError = (err: any) => {
      setError(err.message || 'BLE Mesh Error');
    };

    bleMeshInstance.on('onSOSReceived', handleSOSReceived);
    bleMeshInstance.on('onError', handleError);

    bleMeshInstance.startScanning();
    setIsScanning(true);

    return () => {
      bleMeshInstance.off('onSOSReceived', handleSOSReceived);
      bleMeshInstance.off('onError', handleError);
      bleMeshInstance.stopScanning();
      setIsScanning(false);
    };
  }, [selfDeviceId, selfLocation]);

  const dismissSOS = useCallback((sosId: string) => {
    setNearbySOSEvents(prev => prev.filter(e => e.sosId !== sosId));
  }, []);

  return {
    isScanning,
    nearbySOSEvents,
    error,
    dismissSOS
  };
}
