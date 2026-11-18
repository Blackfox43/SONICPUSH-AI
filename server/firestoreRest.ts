import fs from 'fs';
import path from 'path';

interface FirebaseAppletConfig {
  apiKey: string;
  projectId: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
}

let cachedConfig: FirebaseAppletConfig | null = null;

export function getFirebaseConfig(): FirebaseAppletConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  cachedConfig = JSON.parse(raw) as FirebaseAppletConfig;
  return cachedConfig;
}

function getFirestoreBaseUrl(): string {
  const cfg = getFirebaseConfig();
  const dbId = cfg.firestoreDatabaseId || '(default)';
  return `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/${dbId}/documents`;
}

export type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export function fromFirestoreValue(val: FirestoreValue | undefined): unknown {
  if (!val) return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map((v) => fromFirestoreValue(v));
  }
  if ('mapValue' in val) {
    return fromFirestoreFields(val.mapValue.fields || {});
  }
  return undefined;
}

export function fromFirestoreFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = fromFirestoreValue(value);
  }
  return result;
}

export function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => toFirestoreValue(item)) } };
  }
  if (typeof value === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

export function toFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      fields[k] = toFirestoreValue(v);
    }
  }
  return fields;
}

export async function getFirestoreDoc(
  collectionName: string,
  docId: string,
  idToken: string
): Promise<Record<string, unknown> | null> {
  const safeCol = encodeURIComponent(collectionName);
  const safeId = encodeURIComponent(docId);
  const url = `${getFirestoreBaseUrl()}/${safeCol}/${safeId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) return null;
  if (res.status === 403) {
    throw new Error('PERMISSION_DENIED: You do not have permission to access this resource.');
  }
  if (!res.ok) {
    throw new Error(`Firestore read failed (${res.status}).`);
  }
  const json = (await res.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
  const parsed = fromFirestoreFields(json.fields || {});
  if (!parsed.id && json.name) {
    parsed.id = json.name.split('/').pop();
  }
  return parsed;
}

export interface QueryFilter {
  field: string;
  op: 'EQUAL' | 'ARRAY_CONTAINS';
  value: string;
}

export async function runFirestoreQuery(
  collectionName: string,
  idToken: string,
  filters: QueryFilter[],
  limit = 25
): Promise<Array<Record<string, unknown>>> {
  const baseUrl = getFirestoreBaseUrl();
  const fieldFilters = filters.map((f) => ({
    fieldFilter: {
      field: { fieldPath: f.field },
      op: f.op,
      value: { stringValue: f.value },
    },
  }));

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: collectionName }],
    limit,
  };

  if (fieldFilters.length === 1) {
    structuredQuery.where = fieldFilters[0];
  } else if (fieldFilters.length > 1) {
    structuredQuery.where = {
      compositeFilter: {
        op: 'AND',
        filters: fieldFilters,
      },
    };
  }

  const res = await fetch(`${baseUrl}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });

  if (res.status === 403) {
    throw new Error('PERMISSION_DENIED: Query rejected by Firestore security rules.');
  }
  if (!res.ok) {
    throw new Error(`Firestore query failed (${res.status}).`);
  }

  const rows = (await res.json()) as Array<{
    document?: { name?: string; fields?: Record<string, FirestoreValue> };
  }>;

  const docs: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (!row.document?.fields) continue;
    const parsed = fromFirestoreFields(row.document.fields);
    if (!parsed.id && row.document.name) {
      parsed.id = row.document.name.split('/').pop();
    }
    docs.push(parsed);
  }
  return docs;
}

export async function patchFirestoreDoc(
  collectionName: string,
  docId: string,
  patch: Record<string, unknown>,
  idToken: string
): Promise<void> {
  const safeCol = encodeURIComponent(collectionName);
  const safeId = encodeURIComponent(docId);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const maskParams = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `${getFirestoreBaseUrl()}/${safeCol}/${safeId}?${maskParams}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toFirestoreFields(patch) }),
  });

  if (res.status === 403) {
    throw new Error('PERMISSION_DENIED: Insufficient permissions to update this document.');
  }
  if (!res.ok) {
    throw new Error(`Firestore update failed (${res.status}).`);
  }
}

export async function createFirestoreDocWithServerTime(
  collectionName: string,
  docId: string,
  payload: Record<string, unknown>,
  idToken: string
): Promise<void> {
  const safeCol = encodeURIComponent(collectionName);
  const url = `${getFirestoreBaseUrl()}/${safeCol}?documentId=${encodeURIComponent(docId)}`;

  const res = await fetch(`${getFirestoreBaseUrl()}:commit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: `${url.replace(/^https:\/\/firestore\.googleapis\.com\/v1\//, '').split('?')[0]}/${docId}`,
            fields: toFirestoreFields({ ...payload, id: docId }),
          },
          currentDocument: { exists: false },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
      ],
    }),
  });

  if (res.status === 403) {
    throw new Error('PERMISSION_DENIED: Security rules rejected document creation.');
  }
  if (!res.ok) {
    throw new Error(`Firestore commit failed (${res.status}).`);
  }
}

export async function fetchAuthorizedWorkspaceContext(options: {
  idToken: string;
  uid: string;
  isSuperAdmin: boolean;
  organizationId: string;
}): Promise<{
  organizationId: string;
  artists: Array<Record<string, unknown>>;
  songs: Array<Record<string, unknown>>;
  campaigns: Array<Record<string, unknown>>;
  recentMetrics: Array<Record<string, unknown>>;
  openTasks: Array<Record<string, unknown>>;
}> {
  const baseFilters: QueryFilter[] = options.isSuperAdmin
    ? []
    : [{ field: 'assignedUserIds', op: 'ARRAY_CONTAINS', value: options.uid }];

  const scopedFilters: QueryFilter[] = options.isSuperAdmin && options.organizationId
    ? [{ field: 'organizationId', op: 'EQUAL', value: options.organizationId }]
    : baseFilters;

  const [artistsRaw, songsRaw, campaignsRaw, metricsRaw, tasksRaw] = await Promise.all([
    runFirestoreQuery('artists', options.idToken, scopedFilters, 15).catch(() => []),
    runFirestoreQuery('songs', options.idToken, scopedFilters, 15).catch(() => []),
    runFirestoreQuery('campaigns', options.idToken, scopedFilters, 12).catch(() => []),
    runFirestoreQuery('campaign_metrics', options.idToken, scopedFilters, 20).catch(() => []),
    runFirestoreQuery('campaign_tasks', options.idToken, scopedFilters, 20).catch(() => []),
  ]);

  return {
    organizationId: options.organizationId,
    artists: artistsRaw.map((a) => ({
      id: a.id,
      name: a.name,
      country: a.country,
      city: a.city,
      genre: a.genre,
      careerStage: a.careerStage,
      archived: Boolean(a.archived),
      objectives: a.marketingObjectives,
    })),
    songs: songsRaw.map((s) => ({
      id: s.id,
      title: s.title,
      artistName: s.artistName,
      genre: s.genre,
      language: s.language,
      releaseDate: s.releaseDate,
      audioProcessed: Boolean(s.audioProcessed),
      message: s.message,
    })),
    campaigns: campaignsRaw.map((c) => ({
      id: c.id,
      name: c.name,
      artistName: c.artistName,
      type: c.campaignType,
      durationDays: c.durationDays,
      currency: c.currency,
      budget: c.budget,
      status: c.status,
      targetMarkets: c.targetMarkets,
    })),
    recentMetrics: metricsRaw.map((m) => ({
      campaignName: m.campaignName,
      platform: m.platform,
      recordedDate: m.recordedDate,
      entrySource: m.entrySource,
      reach: m.reach,
      videoViews: m.videoViews,
      engagement: m.engagement,
      reportedStreams: m.reportedStreams,
      adSpend: m.adSpend,
      currency: m.currency,
    })),
    openTasks: tasksRaw
      .filter((t) => t.status !== 'done')
      .slice(0, 15)
      .map((t) => ({
        title: t.title,
        department: t.department,
        dueDate: t.dueDate,
        priority: t.priority,
        status: t.status,
      })),
  };
}
