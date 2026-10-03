import { useEffect } from 'react';
import { startMeshRuntime, stopMeshRuntime } from '../services/mesh-runtime.service';
import * as Notifications from 'expo-notifications';
import { router, DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  useEffect(() => {
    void startMeshRuntime().catch(() => undefined);
    const notification = Notifications.addNotificationResponseReceivedListener(() => router.push('/'));
    return () => { notification.remove(); stopMeshRuntime(); };
  }, []);
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <AppTabs />
    </ThemeProvider>
  );
}
