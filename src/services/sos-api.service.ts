/**
 * @fileoverview API Service for SOS operations using standard fetch.
 */

import { SOSPayload, SOSCancellation, SOSResponse, ActiveSOSEvent } from '../interfaces/sos.types';

const BASE_URL = 'http://10.61.126.110:8000/api/v1';

export class SOSApiService {
  /**
   * Generic request handler with exponential backoff retry.
   */
  private static async request<T>(
    endpoint: string, 
    options: RequestInit, 
    retries = 3
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(`${BASE_URL}${endpoint}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
          },
        });
        
        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.message || 'API Request failed');
        }
        
        return data as T;
      } catch (error) {
        if (i === retries - 1) throw error;
        // Exponential backoff: 500ms, 1000ms, 2000ms...
        await new Promise(res => setTimeout(res, 500 * Math.pow(2, i)));
      }
    }
    throw new Error('Unreachable code');
  }

  /**
   * Send a direct or relayed SOS payload to the server.
   */
  public static async sendSOS(payload: SOSPayload): Promise<SOSResponse> {
    const headers: Record<string, string> = {};
    if (payload.authToken) {
      headers['Authorization'] = `Bearer ${payload.authToken}`;
    }

    return this.request<SOSResponse>('/sos', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers,
    });
  }

  /**
   * Cancel an active SOS alert.
   */
  public static async cancelSOS(cancellation: SOSCancellation, authToken?: string): Promise<SOSResponse> {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    return this.request<SOSResponse>('/sos/cancel', {
      method: 'POST',
      body: JSON.stringify(cancellation),
      headers,
    });
  }

  /**
   * Fetch active SOS events nearby.
   */
  public static async getActiveSOS(
    lat: number, 
    lng: number, 
    radiusKm: number, 
    authToken?: string
  ): Promise<ActiveSOSEvent[]> {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    return this.request<ActiveSOSEvent[]>(`/sos/active?lat=${lat}&lng=${lng}&radiusKm=${radiusKm}`, {
      method: 'GET',
      headers,
    });
  }

  /**
   * Upload media attachments related to an SOS.
   */
  public static async uploadMedia(
    sosId: string, 
    fileUri: string, 
    authToken: string
  ): Promise<{ success: boolean; mediaId: string }> {
    const formData = new FormData();
    // In React Native, we can append a file using this object format
    formData.append('media', {
      uri: fileUri,
      name: `sos_media_${sosId}.jpg`,
      type: 'image/jpeg',
    } as any);

    const response = await fetch(`${BASE_URL}/sos/media?sosId=${sosId}`, {
      method: 'POST',
      body: formData,
      headers: {
        'Authorization': `Bearer ${authToken}`,
        // Content-Type is set automatically by fetch when using FormData
      },
    });

    if (!response.ok) {
      throw new Error('Media upload failed');
    }

    return response.json();
  }
}
