export function formatExtractionPayload(metadata = {}, items = []) {
  return {
    extractor: 'PIRATES ALERT',
    version: '1.0.0',
    extractedAt: new Date().toISOString(),
    page: {
      url: metadata.url || '',
      title: metadata.title || ''
    },
    totalItems: items.length,
    items
  };
}

export function serializeToJson(data, pretty = true) {
  try {
    return JSON.stringify(data, null, pretty ? 2 : 0);
  } catch {
    return '{}';
  }
}

export function triggerJsonDownload(data, filename = 'pirates-alert-export.json') {
  if (typeof document === 'undefined') {
    return false;
  }
  const jsonContent = typeof data === 'string' ? data : serializeToJson(data);
  const blob = new Blob([jsonContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return true;
}
