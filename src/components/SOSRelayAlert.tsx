/**
 * @fileoverview Modal alert displayed when a relay node receives an SOS.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity
} from 'react-native';
import { ActiveSOSEvent } from '../interfaces/sos.types';

interface SOSRelayAlertProps {
  sosEvent: ActiveSOSEvent;
  visible: boolean;
  onDismiss: () => void;
  onHelp: () => void;
}

export const SOSRelayAlert: React.FC<SOSRelayAlertProps> = ({
  sosEvent,
  visible,
  onDismiss,
  onHelp
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const timeSince = Math.max(0, Math.floor((now - Date.parse(sosEvent.timestamp)) / 60000));
  
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.overlay}>
        <View style={styles.alertBox}>
          <View style={styles.header}>
            <Text style={styles.headerText}>EMERGENCY NEARBY</Text>
          </View>
          
          <View style={styles.content}>
            <Text style={styles.typeText}>{sosEvent.sosType} ALERT</Text>
            <Text style={styles.nameText}>{sosEvent.userName} needs help!</Text>
            
            <View style={styles.detailsRow}>
              {sosEvent.distanceMeters !== undefined && (
                <Text style={styles.detailText}>
                  📍 {(sosEvent.distanceMeters / 1000).toFixed(1)} km away
                </Text>
              )}
              <Text style={styles.detailText}>
                ⏱️ {timeSince} mins ago
              </Text>
            </View>
            
            <Text style={styles.relayStatus}>
              {sosEvent.deliveryMethod === 'BLE_RELAY' 
                ? 'Relaying via offline mesh...' 
                : 'Uploading to server...'}
            </Text>
          </View>

          <View style={styles.buttonContainer}>
            <TouchableOpacity style={[styles.button, styles.dismissButton]} onPress={onDismiss}>
              <Text style={styles.dismissButtonText}>Dismiss</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={[styles.button, styles.helpButton]} onPress={onHelp}>
              <Text style={styles.helpButtonText}>Go Help</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  alertBox: {
    backgroundColor: '#FFF',
    borderRadius: 16,
    width: '100%',
    overflow: 'hidden',
    elevation: 5,
  },
  header: {
    backgroundColor: '#FF3B30',
    padding: 15,
    alignItems: 'center',
  },
  headerText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 18,
    letterSpacing: 1,
  },
  content: {
    padding: 20,
    alignItems: 'center',
  },
  typeText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#333',
    marginBottom: 5,
  },
  nameText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 15,
  },
  detailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginBottom: 15,
  },
  detailText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#444',
  },
  relayStatus: {
    fontSize: 12,
    color: '#888',
    fontStyle: 'italic',
  },
  buttonContainer: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#EEE',
  },
  button: {
    flex: 1,
    padding: 15,
    alignItems: 'center',
  },
  dismissButton: {
    backgroundColor: '#F8F8F8',
  },
  dismissButtonText: {
    color: '#666',
    fontWeight: '600',
    fontSize: 16,
  },
  helpButton: {
    backgroundColor: '#34C759',
  },
  helpButtonText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
});
