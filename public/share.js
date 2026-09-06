const content = document.getElementById("shareContent");
const params = new URLSearchParams(location.search);
const shareId = params.get("id");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function load() {
  if (!shareId) {
    content.innerHTML = `<p class="empty-state">This link is missing its ID.</p>`;
    return;
  }
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(shareId)}`);
    const data = await res.json();
    if (!res.ok) {
      content.innerHTML = `<p class="empty-state">${escapeHtml(data.error || "This link isn't available.")}</p>`;
      return;
    }
    const expiresText = data.expiresAt
      ? new Date(data.expiresAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";

    content.innerHTML = `
      <p class="reflection" style="font-size: 1.1rem;">${escapeHtml(data.summary)}</p>
      <div class="meta-row" style="margin: 14px 0;">
        ${(data.highlightThemes || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
      </div>
      <p class="section-note">Based on ${data.entryCount} recent entries · this link expires ${expiresText}</p>
    `;
  } catch (err) {
    content.innerHTML = `<p class="empty-state">Could not load this recap. Check your connection and try again.</p>`;
  }
}

load();
