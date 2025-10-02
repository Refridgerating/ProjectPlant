import type { CapacitorConfig } from '@capacitor/cli';

const devServerUrl =
  process.env.CAP_SERVER_URL ??
  process.env.CAPACITOR_SERVER_URL ??
  process.env.CAP_DEV_SERVER_URL ??
  (process.env.NODE_ENV === 'development' ? 'http://localhost:5173' : undefined);

const config: CapacitorConfig = {
  appId: 'com.projectplant.app',
  appName: 'ProjectPlant',
  webDir: 'dist',
  ...(devServerUrl
    ? {
        server: {
          url: devServerUrl,
          cleartext: devServerUrl.startsWith('http://')
        }
      }
    : {})
};

export default config;
