import { useEffect, useState, useCallback } from 'react';
import { bleMeshInstance } from '../services/sos-trigger.service';
import { nearbyEvents, isRelayEnabled } from '../services/mesh-runtime.service';
import { ActiveSOSEvent } from '../interfaces/sos.types';
export function useBLEMesh(_selfDeviceId: string) {
  const [nearbySOSEvents, setNearby] = useState<ActiveSOSEvent[]>([]);
  const [isScanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const reload = () => { void nearbyEvents().then(events => { if (mounted) setNearby(events); }); };
    const report = (error: Error) => setError(error.message);
    reload(); void isRelayEnabled().then(setScanning);
    bleMeshInstance.on('onSOSReceived', reload); bleMeshInstance.on('onError', report);
    const timer = setInterval(() => { reload(); void isRelayEnabled().then(value => { if (mounted) setScanning(value); }); }, 15000);
    return () => { mounted = false; clearInterval(timer); bleMeshInstance.off('onSOSReceived', reload); bleMeshInstance.off('onError', report); };
  }, []);
  const dismissSOS = useCallback((id: string) => setNearby(events => events.filter(event => event.sosId !== id)), []);
  return { nearbySOSEvents, isScanning, error, dismissSOS };
}
