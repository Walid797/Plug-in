// Save a generated Blob as a local file. No network involved.

export async function saveBlob(blob, fileName) {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('EMPTY_FILE');
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // keep the URL alive long enough for the browser to start the download
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}

/** Read a user-chosen file as text (templates import). */
export function readFileText(file, maxBytes = 2 * 1024 * 1024) {
  if (file.size > maxBytes) return Promise.reject(new Error('TOO_LARGE'));
  return file.text();
}
