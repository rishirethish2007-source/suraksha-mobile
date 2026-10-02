/**
 * @fileoverview Network service to check for active internet connectivity.
 */

import NetInfo, { NetInfoState, NetInfoSubscription } from '@react-native-community/netinfo';

export class NetworkService {
  /**
   * Checks the network connectivity.
   * Verifies both the interface connection and actual internet reachability 
   * to avoid false positives with captive portals or local-only connections.
   */
  public static async checkConnectivity(): Promise<{ isOnline: boolean; connectionType: string }> {
    const state: NetInfoState = await NetInfo.fetch();
    
    // Some devices report true for isConnected on captive portals, so we verify with isInternetReachable
    const isOnline = !!(state.isConnected && state.isInternetReachable);
    
    // In disaster zones, if state.isInternetReachable is null (still checking), 
    // we may want to perform a direct ping test to be absolutely sure.
    let confirmedOnline = isOnline;
    if (state.isConnected && state.isInternetReachable === null) {
      confirmedOnline = await this.pingServer();
    }
    
    return {
      isOnline: confirmedOnline,
      connectionType: state.type
    };
  }

  /**
   * Subscribes to network state changes.
   * @param callback Function to call when network state changes
   * @returns A function to unsubscribe
   */
  public static subscribe(callback: (isOnline: boolean) => void): NetInfoSubscription {
    return NetInfo.addEventListener(state => {
      const isOnline = !!(state.isConnected && state.isInternetReachable);
      callback(isOnline);
    });
  }

  /**
   * Performs a quick, lightweight ping to a reliable server (or our own backend)
   * to confirm reachability.
   */
  private static async pingServer(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
      
      const response = await fetch('https://1.1.1.1', {
        method: 'HEAD',
        signal: controller.signal,
        cache: 'no-store'
      });
      
      clearTimeout(timeoutId);
      return response.ok;
    } catch (e) {
      return false;
    }
  }
}
