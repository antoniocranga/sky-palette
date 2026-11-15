/* Admin moderation page: token in memory only, same-origin API calls. */
(() => {
  "use strict";

  let token = "";
  const form = document.getElementById("auth");
  const tokenInput = document.getElementById("token");
  const statusSelect = document.getElementById("status");
  const message = document.getElementById("message");
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");

  function say(text, isError = false) {
    message.textContent = text;
    message.classList.toggle("error", isError);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error || `Request failed (${response.status})`);
    }
    return body;
  }

  function card(item) {
    const article = document.createElement("article");
    const img = document.createElement("img");
    img.alt = `Sky photo by @${item.handle}`;
    img.loading = "lazy";
    img.width = 240;
    img.height = 180;
    void loadImage(item.thumbUrl, img);

    const body = document.createElement("div");
    body.className = "body";

    const top = document.createElement("div");
    top.className = "row";
    const handle = document.createElement("strong");
    handle.textContent = `@${item.handle}`;
    const date = document.createElement("span");
    date.textContent = new Date(item.capturedAt).toLocaleString();
    top.append(handle, date);

    const meta = document.createElement("div");
    meta.className = "row muted";
    meta.textContent = `${item.width}×${item.height} · ${item.status}`;

    const actions = document.createElement("div");
    actions.className = "actions";

    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Approve";
    approve.addEventListener("click", () => setStatus(item, "approved"));

    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "ghost";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => setStatus(item, "rejected"));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => removeItem(item));

    const open = document.createElement("button");
    open.type = "button";
    open.className = "ghost";
    open.textContent = "Open full image";
    open.addEventListener("click", () => void openFull(item.url));

    actions.append(approve, reject, remove);
    body.append(top, meta, actions, open);
    article.append(img, body);
    return article;
  }

  const objectUrls = new Set();

  async function fetchBlob(url) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Image ${response.status}`);
    return response.blob();
  }

  async function loadImage(url, img) {
    try {
      const blob = await fetchBlob(url);
      const objectUrl = URL.createObjectURL(blob);
      objectUrls.add(objectUrl);
      img.src = objectUrl;
    } catch {
      img.alt = "Preview unavailable";
    }
  }

  async function openFull(url) {
    try {
      const blob = await fetchBlob(url);
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      say(error.message, true);
    }
  }

  function releaseUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  async function setStatus(item, status) {
    try {
      await api(`/api/admin/submissions/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      say(`${item.handle} → ${status}`);
      await load();
    } catch (error) {
      say(error.message, true);
    }
  }

  async function removeItem(item) {
    if (!window.confirm(`Delete ${item.handle}? This removes the image from R2 and the record.`)) return;
    try {
      await api(`/api/admin/submissions/${item.id}`, { method: "DELETE" });
      say(`${item.handle} deleted`);
      await load();
    } catch (error) {
      say(error.message, true);
    }
  }

  async function load() {
    releaseUrls();
    grid.replaceChildren();
    empty.hidden = true;
    say("Loading…");
    try {
      const body = await api(`/api/admin/submissions?status=${encodeURIComponent(statusSelect.value)}`);
      const items = body.submissions || [];
      for (const item of items) grid.append(card(item));
      empty.hidden = items.length > 0;
      say(`${items.length} ${statusSelect.value}`);
    } catch (error) {
      say(error.message, true);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    token = tokenInput.value.trim();
    if (!token) {
      say("Enter the admin token.", true);
      return;
    }
    void load();
  });

  statusSelect.addEventListener("change", () => {
    if (token) void load();
  });
})();
