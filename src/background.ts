import { AppRegistry, Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import { processMeshWork, RETRY_TASK } from './services/mesh-runtime.service';

// Must be defined at module scope so the OS can invoke it without a mounted screen.
if (Platform.OS === 'android') AppRegistry.registerHeadlessTask('SurakshaRelay', () => processMeshWork);
if (Platform.OS !== 'web') {
  TaskManager.defineTask(RETRY_TASK, async () => {
    try { await processMeshWork(); return BackgroundTask.BackgroundTaskResult.Success; }
    catch { return BackgroundTask.BackgroundTaskResult.Failed; }
  });
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldPlaySound: true,
    shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }) });
}
