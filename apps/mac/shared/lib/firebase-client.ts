import "client-only";
import { getApp, getApps, initializeApp, type FirebaseOptions } from "firebase/app";

const envConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Boolean(envConfig.apiKey && envConfig.projectId && envConfig.appId);

if (!isFirebaseConfigured) {
  console.warn("[codelit] NEXT_PUBLIC_FIREBASE_* env vars missing. Auth and cloud persistence are disabled until they are set.");
}

const firebaseConfig: FirebaseOptions = isFirebaseConfigured ? envConfig : {
  apiKey: "unconfigured",
  authDomain: "unconfigured.firebaseapp.com",
  projectId: "unconfigured",
  appId: "1:0:web:unconfigured",
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
