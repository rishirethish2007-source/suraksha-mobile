/**
 * @fileoverview SOS Button Component with long-press protection and pulsing animation.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Vibration,
  ViewStyle,
  Modal,
  TouchableOpacity
} from 'react-native';
import { SOSType } from '../interfaces/sos.types';

interface SOSButtonProps {
  onTrigger: (sosType: SOSType) => void;
  disabled?: boolean;
  style?: ViewStyle;
}

const LONG_PRESS_DURATION_MS = 3000;

export const SOSButton: React.FC<SOSButtonProps> = ({ onTrigger, disabled, style }) => {
  const [isPressing, setIsPressing] = useState(false);
  const [isTriggered, setIsTriggered] = useState(false);
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  
  const [progressAnim] = useState(() => new Animated.Value(0));
  const [pulseAnim] = useState(() => new Animated.Value(1));
  const pressTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pulse animation for idle state
  useEffect(() => {
    if (!isPressing && !isTriggered && !disabled) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.1,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isPressing, isTriggered, disabled, pulseAnim]);

  const handlePressIn = () => {
    if (disabled || isTriggered) return;
    setIsPressing(true);
    Vibration.vibrate(50);

    Animated.timing(progressAnim, {
      toValue: 1,
      duration: LONG_PRESS_DURATION_MS,
      useNativeDriver: false,
    }).start();

    pressTimeout.current = setTimeout(() => {
      setIsPressing(false);
      setIsTriggered(true);
      Vibration.vibrate([0, 500, 200, 500]); // Distinct SOS vibration pattern
      setShowTypeSelector(true);
    }, LONG_PRESS_DURATION_MS);
  };

  const handlePressOut = () => {
    if (pressTimeout.current) clearTimeout(pressTimeout.current);
    setIsPressing(false);
    
    Animated.timing(progressAnim, {
      toValue: 0,
      duration: 300,
      useNativeDriver: false,
    }).start();
  };

  useEffect(() => () => {
    if (pressTimeout.current) clearTimeout(pressTimeout.current);
  }, []);

  const handleTypeSelect = (type: SOSType) => {
    setShowTypeSelector(false);
    onTrigger(type);
    setIsTriggered(false);
    progressAnim.setValue(0);
  };

  const progressHeight = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%']
  });

  return (
    <View style={[styles.container, style]}>
      <Animated.View
        style={[
          styles.buttonOuter,
          { transform: [{ scale: pulseAnim }] }
        ]}
        onStartShouldSetResponder={() => !disabled}
        onResponderGrant={handlePressIn}
        onResponderRelease={handlePressOut}
        onResponderTerminate={handlePressOut}
      >
        <View style={styles.buttonInner}>
          <Animated.View style={[styles.progressFill, { height: progressHeight }]} />
          <Text style={styles.buttonText}>
            {isTriggered ? 'SELECT' : isPressing ? 'HOLD' : 'SOS'}
          </Text>
        </View>
      </Animated.View>

      <Modal visible={showTypeSelector} transparent animationType="slide" onRequestClose={() => { setShowTypeSelector(false); setIsTriggered(false); progressAnim.setValue(0); }}>
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Select Emergency Type</Text>
            {Object.values(SOSType).map(type => (
              <TouchableOpacity
                key={type}
                style={styles.typeButton}
                onPress={() => handleTypeSelect(type as SOSType)}
              >
                <Text style={styles.typeButtonText}>{type}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonOuter: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255, 59, 48, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonInner: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: '#FF3B30',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  progressFill: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#CC2211',
  },
  buttonText: {
    color: '#FFF',
    fontSize: 48,
    fontWeight: 'bold',
    zIndex: 1,
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalContent: {
    backgroundColor: '#FFF',
    padding: 20,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  typeButton: {
    padding: 15,
    backgroundColor: '#F0F0F0',
    borderRadius: 10,
    marginBottom: 10,
  },
  typeButtonText: {
    fontSize: 16,
    textAlign: 'center',
    fontWeight: '600',
  }
});
