import { auth } from './firebase';

async function getAuthHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('You must be signed in to run this operation.');
  }
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
  };
}

export async function getJsonApi<TResponse>(url: string): Promise<TResponse> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...authHeaders,
    },
  });

  const data = (await res.json()) as TResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export async function postJsonApi<TResponse>(
  url: string,
  body: Record<string, unknown>
): Promise<TResponse> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as TResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export async function postFormApi<TResponse>(
  url: string,
  formData: FormData
): Promise<TResponse> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders,
    },
    body: formData,
  });

  const data = (await res.json()) as TResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export async function deleteJsonApi<TResponse>(url: string): Promise<TResponse> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...authHeaders,
    },
  });

  const data = (await res.json()) as TResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export async function fetchAuthorizedBlob(url: string): Promise<Blob> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...authHeaders,
    },
  });
  if (!res.ok) {
    throw new Error(`Unable to fetch protected audio (${res.status})`);
  }
  return res.blob();
}
