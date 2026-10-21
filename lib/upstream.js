export function finite(value) {
  if (
    value == null ||
    typeof value === "boolean" ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function upstreamFetch(
  url,
  options = {},
  timeoutMs = 9000
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      text
    };
  } catch (error) {
    throw new Error(
      error.name === "AbortError"
        ? "Upstream request timed out"
        : "Upstream network request failed"
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function upstreamJson(
  url,
  options = {},
  label = "Provider"
) {
  const response = await upstreamFetch(url, options);

  let body;

  try {
    body = JSON.parse(response.text);
  } catch {
    throw new Error(
      `${label} returned invalid JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok) {
    const detail =
      typeof body?.error_message === "string"
        ? body.error_message
        : "";

    throw new Error(
      `${label} HTTP ${response.status}${
        detail ? ": " + detail : ""
      }`
    );
  }

  if (!body || typeof body !== "object") {
    throw new Error(`${label} returned an invalid response`);
  }

  return body;
}

export function fredRows(body, label) {
  if (body.error_code) {
    throw new Error(
      body.error_message || `${label} lookup failed`
    );
  }

  if (!Array.isArray(body.observations)) {
    throw new Error(
      `${label}: observations missing from response`
    );
  }

  const rows = body.observations
    .map(row => ({
      date: row.date,
      value: finite(row.value)
    }))
    .filter(
      row =>
        /^\d{4}-\d{2}-\d{2}$/.test(row.date || "") &&
        row.value != null
    );

  if (!rows.length) {
    throw new Error(
      `${label}: no usable observations returned`
    );
  }

  return rows;
}

export function noStoreErrors(res) {
  const originalStatus = res.status;

  res.status = function(code) {
    if (code >= 400) {
      res.setHeader("Cache-Control", "no-store");
    }

    return originalStatus.call(this, code);
  };
}
