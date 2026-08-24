import "client-only";
import {
  arrayUnion,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  where,
} from "firebase/firestore";
import { firebaseApp } from "./firebase-client";

export const db = getFirestore(firebaseApp);

const emulatorAddress = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
if (emulatorAddress) {
  const [host, portValue] = emulatorAddress.split(":");
  const port = Number(portValue);
  const marker = globalThis as typeof globalThis & { __codelitFirestoreEmulator?: string };
  if (host && Number.isInteger(port) && port > 0 && marker.__codelitFirestoreEmulator !== emulatorAddress) {
    connectFirestoreEmulator(db, host, port);
    marker.__codelitFirestoreEmulator = emulatorAddress;
  }
}

export {
  arrayUnion,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  where,
};
