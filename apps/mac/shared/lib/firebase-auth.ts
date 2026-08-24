import "client-only";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type AuthProvider,
  type User,
} from "firebase/auth";
import { firebaseApp } from "./firebase-client";

function initializeCodelitAuth() {
  try {
    return initializeAuth(firebaseApp, {
      persistence: [
        indexedDBLocalPersistence,
        browserLocalPersistence,
        browserSessionPersistence,
      ],
    });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "auth/already-initialized") {
      return getAuth(firebaseApp);
    }
    throw error;
  }
}

export const auth = initializeCodelitAuth();

const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();

async function handleSignIn(provider: AuthProvider) {
  try {
    return await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  } catch (error: unknown) {
    const err = error as { code?: string; customData?: { email?: string } };

    if (err.code === "auth/account-exists-with-different-credential") {
      const email = err.customData?.email;
      if (email) {
        const methods = await fetchSignInMethodsForEmail(auth, email);
        const name = methods[0] === "google.com" ? "Google" : "GitHub";
        alert(`This email is already linked to ${name}. Please sign in with ${name} instead.`);
      }
      return null;
    }

    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
      return null;
    }

    console.error("Auth error:", err.code, error);
    return null;
  }
}

export const signInWithGoogle = () => handleSignIn(googleProvider);
export const signInWithGithub = () => handleSignIn(githubProvider);
export const signInWithFirebaseToken = (token: string) => signInWithCustomToken(auth, token);

export async function signUpWithEmail(email: string, password: string, displayName?: string) {
  try {
    const result = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName && result.user) {
      await updateProfile(result.user, { displayName });
    }
    return result;
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code === "auth/email-already-in-use") throw new Error("Email already in use. Try signing in instead.");
    if (err.code === "auth/weak-password") throw new Error("Password must be at least 6 characters.");
    if (err.code === "auth/invalid-email") throw new Error("Invalid email address.");
    throw new Error(err.message || "Sign up failed");
  }
}

export async function signInWithEmail(email: string, password: string) {
  try {
    return await signInWithEmailAndPassword(auth, email, password);
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code === "auth/user-not-found" || err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
      throw new Error("Invalid email or password.");
    }
    if (err.code === "auth/too-many-requests") throw new Error("Too many attempts. Try again later.");
    throw new Error(err.message || "Sign in failed");
  }
}

export async function resetPassword(email: string) {
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code === "auth/user-not-found") throw new Error("No account found with this email.");
    throw new Error(err.message || "Password reset failed");
  }
}

export const logOut = async () => {
  const user = auth.currentUser;
  const idToken = user ? await user.getIdToken().catch(() => undefined) : undefined;
  const { disconnectAllIntegrationSessions } = await import("./integration-session-client");
  await disconnectAllIntegrationSessions(idToken);
  return signOut(auth);
};

export { onAuthStateChanged };
export type { User };
