import { getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, type Firestore, type WhereFilterOp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getFirebaseConfig } from './firestoreRest.ts';
import { logStructured, sanitizeErrorMessage } from './logger.ts';

let cachedApp: App | null = null;
let cachedFirestore: Firestore | null = null;
let cachedAuth: Auth | null = null;

export const SERVER_TIMESTAMP_SENTINEL = '__SONICPUSH_SERVER_TIMESTAMP__';

export interface AdminTx {
  get(collection: string, id: string): Promise<Record<string, unknown> | null>;
  set(collection: string, id: string, data: Record<string, unknown>, merge?: boolean): Promise<void>;
  update(collection: string, id: string, patch: Record<string, unknown>): Promise<void>;
}

export interface AdminQueryFilter {
  field: string;
  op: '==' | '<=' | '>=' | '<' | '>' | 'in' | 'array-contains';
  value: unknown;
}

export interface AdminFirestoreAdapter {
  getDoc(collection: string, id: string): Promise<Record<string, unknown> | null>;
  setDoc(collection: string, id: string, data: Record<string, unknown>, merge?: boolean): Promise<void>;
  updateDoc(collection: string, id: string, patch: Record<string, unknown>): Promise<void>;
  deleteDoc(collection: string, id: string): Promise<void>;
  queryDocs(
    collection: string,
    filters: AdminQueryFilter[],
    options?: { orderBy?: { field: string; dir: 'asc' | 'desc' }; limit?: number }
  ): Promise<Array<Record<string, unknown>>>;
  runTransaction<T>(fn: (tx: AdminTx) => Promise<T>): Promise<T>;
}

export interface FirebaseAdminDiagnostics {
  initialized: boolean;
  projectId: string;
  databaseId: string;
  storageBucket: string;
  emulators: {
    firestore: boolean;
    auth: boolean;
    storage: boolean;
  };
  firestoreReady: boolean;
  storageReady: boolean;
  authReady: boolean;
  iamStatus: 'ok' | 'permission_denied_or_unconfigured' | 'error';
  diagnosticNote?: string;
}

export function isPermissionOrCredentialError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 7 ||
    code === 'PERMISSION_DENIED' ||
    code === 'UNAUTHENTICATED' ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('Could not load the default credentials') ||
    msg.includes('Unable to detect a Project Id') ||
    msg.includes('metadata server') ||
    msg.includes('invalid_grant')
  );
}

export function getAdminApp(): App {
  if (cachedApp) return cachedApp;
  const cfg = getFirebaseConfig();

  if (getApps().length > 0) {
    cachedApp = getApp();
    return cachedApp;
  }

  cachedApp = initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || cfg.projectId,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || cfg.storageBucket,
  });
  return cachedApp;
}

export function getAdminFirestore(): Firestore {
  if (cachedFirestore) return cachedFirestore;
  const cfg = getFirebaseConfig();
  const app = getAdminApp();
  const dbId = process.env.FIRESTORE_DATABASE_ID || cfg.firestoreDatabaseId;
  cachedFirestore = dbId ? getFirestore(app, dbId) : getFirestore(app);
  return cachedFirestore;
}

export function getAdminAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  const app = getAdminApp();
  cachedAuth = getAuth(app);
  return cachedAuth;
}

export function getAdminStorageBucket() {
  const cfg = getFirebaseConfig();
  const app = getAdminApp();
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || cfg.storageBucket;
  return getStorage(app).bucket(bucketName);
}

function encodeAdminData(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v === SERVER_TIMESTAMP_SENTINEL) {
      out[k] = FieldValue.serverTimestamp();
    } else {
      out[k] = v;
    }
  }
  return out;
}

function decodeSnapshot(id: string, data: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!data) return null;
  const out: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
      out[k] = (v as { toDate: () => Date }).toDate().toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createFirebaseAdminDbAdapter(): AdminFirestoreAdapter {
  return {
    async getDoc(col: string, id: string) {
      const db = getAdminFirestore();
      const snap = await db.collection(col).doc(id).get();
      if (!snap.exists) return null;
      return decodeSnapshot(snap.id, snap.data() as Record<string, unknown>);
    },
    async setDoc(col: string, id: string, data: Record<string, unknown>, merge = false) {
      const db = getAdminFirestore();
      await db.collection(col).doc(id).set(encodeAdminData(data), { merge });
    },
    async updateDoc(col: string, id: string, patch: Record<string, unknown>) {
      const db = getAdminFirestore();
      await db.collection(col).doc(id).update(encodeAdminData(patch));
    },
    async deleteDoc(col: string, id: string) {
      const db = getAdminFirestore();
      await db.collection(col).doc(id).delete();
    },
    async queryDocs(col: string, filters: AdminQueryFilter[], options) {
      const db = getAdminFirestore();
      let q: FirebaseFirestore.Query = db.collection(col);
      for (const f of filters) {
        q = q.where(f.field, f.op as WhereFilterOp, f.value);
      }
      if (options?.orderBy) {
        q = q.orderBy(options.orderBy.field, options.orderBy.dir);
      }
      if (options?.limit) {
        q = q.limit(options.limit);
      }
      const snap = await q.get();
      return snap.docs.map((d) => decodeSnapshot(d.id, d.data() as Record<string, unknown>)!);
    },
    async runTransaction<T>(fn: (tx: AdminTx) => Promise<T>): Promise<T> {
      const db = getAdminFirestore();
      return db.runTransaction(async (t) => {
        const wrappedTx: AdminTx = {
          async get(col: string, id: string) {
            const snap = await t.get(db.collection(col).doc(id));
            if (!snap.exists) return null;
            return decodeSnapshot(snap.id, snap.data() as Record<string, unknown>);
          },
          async set(col: string, id: string, data: Record<string, unknown>, merge = false) {
            t.set(db.collection(col).doc(id), encodeAdminData(data), { merge });
          },
          async update(col: string, id: string, patch: Record<string, unknown>) {
            t.update(db.collection(col).doc(id), encodeAdminData(patch));
          },
        };
        return fn(wrappedTx);
      });
    },
  };
}

export async function inspectFirebaseAdminHealth(): Promise<FirebaseAdminDiagnostics> {
  const cfg = getFirebaseConfig();
  const projectId = process.env.FIREBASE_PROJECT_ID || cfg.projectId;
  const databaseId = process.env.FIRESTORE_DATABASE_ID || cfg.firestoreDatabaseId || '(default)';
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || cfg.storageBucket || '';
  const emulators = {
    firestore: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
    auth: Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST),
    storage: Boolean(process.env.FIREBASE_STORAGE_EMULATOR_HOST),
  };

  let initialized = false;
  let firestoreReady = false;
  let storageReady = false;
  let authReady = false;
  let iamStatus: FirebaseAdminDiagnostics['iamStatus'] = 'ok';
  let diagnosticNote: string | undefined;

  try {
    getAdminApp();
    initialized = true;
  } catch (err) {
    iamStatus = 'error';
    diagnosticNote = sanitizeErrorMessage(err, 'Failed to initialize Firebase Admin app.');
    return {
      initialized,
      projectId,
      databaseId,
      storageBucket,
      emulators,
      firestoreReady,
      storageReady,
      authReady,
      iamStatus,
      diagnosticNote,
    };
  }

  try {
    const db = getAdminFirestore();
    await db.doc('test/connection').get();
    firestoreReady = true;
  } catch (err) {
    if (isPermissionOrCredentialError(err)) {
      iamStatus = 'permission_denied_or_unconfigured';
      diagnosticNote =
        'Admin Firestore SDK lacks IAM permissions in this environment (expected on Starter Tier without Cloud Billing/IAM; works with Blaze IAM or Emulators).';
    } else {
      iamStatus = 'error';
      diagnosticNote = sanitizeErrorMessage(err, 'Admin Firestore health check failed.');
    }
  }

  try {
    const bucket = getAdminStorageBucket();
    if (emulators.storage) {
      storageReady = Boolean(bucket.name);
    } else {
      const [exists] = await bucket.exists();
      storageReady = Boolean(exists);
    }
  } catch (err) {
    if (isPermissionOrCredentialError(err)) {
      iamStatus = 'permission_denied_or_unconfigured';
      if (!diagnosticNote) {
        diagnosticNote =
          'Admin Storage SDK lacks IAM permissions in this environment (expected on Starter Tier without Blaze/IAM).';
      }
    } else {
      storageReady = false;
    }
  }

  try {
    const auth = getAdminAuth();
    authReady = Boolean(auth);
  } catch {
    authReady = false;
  }

  if (iamStatus !== 'ok') {
    logStructured('warn', 'firebase_admin_diagnostics_degraded', {
      iamStatus,
      firestoreReady,
      storageReady,
    });
  }

  return {
    initialized,
    projectId,
    databaseId,
    storageBucket,
    emulators,
    firestoreReady,
    storageReady,
    authReady,
    iamStatus,
    diagnosticNote,
  };
}
