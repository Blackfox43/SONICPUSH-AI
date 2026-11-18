import React, { useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from './lib/firebase';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastProvider';
import { LandingPage } from './components/LandingPage';
import { OnboardingFlow } from './components/OnboardingFlow';
import { WorkspaceProvider } from './context/WorkspaceContext';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import type { UserProfile } from './types/sonicpush';

function SonicPushRoot() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (!fbUser) {
        setUserProfile(null);
        setAuthReady(true);
        return;
      }

      setLoadingProfile(true);
      try {
        const snap = await getDoc(doc(db, 'users', fbUser.uid));
        if (snap.exists()) {
          setUserProfile(snap.data() as UserProfile);
        } else {
          setUserProfile(null);
        }
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.GET, `users/${fbUser.uid}`);
        } catch (wrapped) {
          setAuthError(wrapped instanceof Error ? wrapped.message : 'Unable to load user profile.');
        }
      } finally {
        setLoadingProfile(false);
        setAuthReady(true);
      }
    });

    return () => unsub();
  }, []);

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(
        err instanceof Error
          ? err.message
          : 'Google Sign-In was cancelled or blocked. Allow popups for this studio and try again.'
      );
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setUserProfile(null);
  };

  if (!authReady || loadingProfile) {
    return (
      <div className="min-h-screen bg-[#09090B] text-white flex items-center justify-center p-6">
        <div className="space-y-3 text-center">
          <div className="h-8 w-8 rounded-full border-2 border-[#FF5500] border-t-transparent animate-spin mx-auto" />
          <p className="text-sm text-zinc-400">Initializing SONICPUSH AI studio...</p>
        </div>
      </div>
    );
  }

  if (!firebaseUser) {
    return (
      <LandingPage
        onSignIn={handleGoogleSignIn}
        signingIn={signingIn}
        authError={authError}
      />
    );
  }

  if (!userProfile || !userProfile.onboardingCompleted) {
    return (
      <OnboardingFlow
        firebaseUid={firebaseUser.uid}
        email={firebaseUser.email || ''}
        displayName={firebaseUser.displayName || ''}
        photoURL={firebaseUser.photoURL || undefined}
        onComplete={(profile) => setUserProfile(profile)}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <WorkspaceProvider user={userProfile}>
      <WorkspaceLayout onSignOut={handleSignOut} />
    </WorkspaceProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <SonicPushRoot />
      </ToastProvider>
    </ErrorBoundary>
  );
}
