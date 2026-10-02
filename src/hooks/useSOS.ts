/**
 * @fileoverview Custom hook for triggering and cancelling SOS.
 */

import { useState, useCallback } from 'react';
import { SOSTriggerService } from '../services/sos-trigger.service';
import { SOSPayload, SOSType } from '../interfaces/sos.types';

export function useSOS() {
  const [isTriggering, setIsTriggering] = useState<boolean>(false);
  const [lastSOS, setLastSOS] = useState<SOSPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const triggerSOS = useCallback(async (
    userId: string,
    userName: string,
    userPhone: string,
    sosType: SOSType,
    authToken?: string,
    message?: string
  ) => {
    setIsTriggering(true);
    setError(null);
    try {
      const payload = await SOSTriggerService.triggerSOS({
        userId,
        userName,
        userPhone,
        sosType,
        authToken,
        message
      });
      setLastSOS(payload);
      return payload;
    } catch (err: any) {
      setError(err.message || 'Failed to trigger SOS');
      throw err;
    } finally {
      setIsTriggering(false);
    }
  }, []);

  const cancelSOS = useCallback(async (
    sosId: string,
    userId: string,
    reason?: string,
    authToken?: string
  ) => {
    setError(null);
    try {
      await SOSTriggerService.cancelSOS(sosId, userId, reason, authToken);
      setLastSOS(null);
    } catch (err: any) {
      setError(err.message || 'Failed to cancel SOS');
      throw err;
    }
  }, []);

  return {
    triggerSOS,
    cancelSOS,
    isTriggering,
    lastSOS,
    error
  };
}
