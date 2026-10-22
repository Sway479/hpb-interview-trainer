import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'edu.hpb.interview',
  appName: '问诊陪练',
  loggingBehavior: 'none',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  android: { allowMixedContent: false },
};
export default config;
