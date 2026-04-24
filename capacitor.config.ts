import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.regli.app',
  appName: 'Regli',
  webDir: 'dist',
  ios: {
    scheme: 'regli',
    contentInset: 'automatic',
  },
  server: {
    // During development, point to the Vite dev server for live reload.
    // Comment out for production builds.
    // url: 'http://YOUR_LOCAL_IP:5173',
    // cleartext: true,
  },
}

export default config
