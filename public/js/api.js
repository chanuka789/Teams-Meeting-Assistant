// JSON API helper. A 401 means the session ended: the app returns to the sign-in page.

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/api/login')) onUnauthorized();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

// Raw POST that returns the Response (for the streamed answer)
export async function apiStream(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin',
  });
  if (res.status === 401) onUnauthorized();
  return res;
}

// File upload with progress (fetch has no upload progress)
export function uploadFile(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 401) onUnauthorized();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Network error during upload.', 0));
    xhr.send(file);
  });
}
