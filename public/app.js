import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const authSection = document.getElementById("authSection");
const appSection = document.getElementById("appSection");
const signOutBtn = document.getElementById("signOutBtn");

const authTabs = document.querySelectorAll("[data-authmode]");
const authForm = document.getElementById("authForm");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const authError = document.getElementById("authError");

const modeTabs = document.querySelectorAll("[data-mode]");
const entryForm = document.getElementById("entryForm");
const entryText = document.getElementById("entryText");
const entrySubmitBtn = document.getElementById("entrySubmitBtn");
const entryError = document.getElementById("entryError");
const modeHint = document.getElementById("modeHint");
const aiResponseEl = document.getElementById("aiResponse");

const timelineEl = document.getElementById("timeline");
const timelineEmpty = document.getElementById("timelineEmpty");

const shareEntryCount = document.getElementById("shareEntryCount");
const shareExpiry = document.getElementById("shareExpiry");
const createShareBtn = document.getElementById("createShareBtn");
const shareError = document.getElementById("shareError");
const shareList = document.getElementById("shareList");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let authMode = "signin"; // 'signin' | 'signup'
let journalMode = "reflect"; // 'reflect' | 'braindump'

const MODE_HINTS = {
  reflect: "MindEcho will look for patterns across your past entries.",
  braindump: "Dump everything. You'll get back one small next step.",
};
const MODE_PLACEHOLDERS = {
  reflect: "What's on your mind today?",
  braindump: "Everything at once — don't organize it, just get it out.",
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
authTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    authMode = tab.dataset.authmode;
    authTabs.forEach((t) => t.classList.toggle("active", t === tab));
    authSubmitBtn.textContent = authMode === "signin" ? "Sign in" : "Create account";
    authError.textContent = "";
  });
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.textContent = "";
  authSubmitBtn.disabled = true;
  try {
    if (authMode === "signin") {
      await signInWithEmailAndPassword(auth, authEmail.value, authPassword.value);
    } else {
      await createUserWithEmailAndPassword(auth, authEmail.value, authPassword.value);
    }
  } catch (err) {
    authError.textContent = describeAuthError(err);
  } finally {
    authSubmitBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    authSection.hidden = true;
    appSection.hidden = false;
    signOutBtn.hidden = false;
    loadEntries();
    loadShares();
  } else {
    authSection.hidden = false;
    appSection.hidden = true;
    signOutBtn.hidden = true;
  }
});

function describeAuthError(err) {
  const code = err?.code || "";
  if (code.includes("email-already-in-use")) return "That email already has an account. Try signing in instead.";
  if (code.includes("weak-password")) return "Password needs to be at least 6 characters.";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Email or password doesn't match an account.";
  }
  if (code.includes("invalid-email")) return "That doesn't look like a valid email address.";
  return "Something went wrong. Try again.";
}

// ---------------------------------------------------------------------------
// Authenticated fetch helper
// ---------------------------------------------------------------------------
async function apiFetch(path, options = {}) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Journal entry mode toggle + submission
// ---------------------------------------------------------------------------
modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    journalMode = tab.dataset.mode;
    modeTabs.forEach((t) => t.classList.toggle("active", t === tab));
    modeHint.textContent = MODE_HINTS[journalMode];
    entryText.placeholder = MODE_PLACEHOLDERS[journalMode];
    aiResponseEl.hidden = true;
  });
});
modeHint.textContent = MODE_HINTS[journalMode];

entryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = entryText.value.trim();
  if (!text) return;

  entryError.textContent = "";
  entrySubmitBtn.disabled = true;
  entrySubmitBtn.textContent = "Thinking…";

  try {
    const { ai, mode } = await apiFetch("/api/entries", {
      method: "POST",
      body: JSON.stringify({ text, mode: journalMode }),
    });
    renderAiResponse(ai, mode);
    entryText.value = "";
    loadEntries();
  } catch (err) {
    entryError.textContent = err.message || "Could not save that entry. Try again.";
  } finally {
    entrySubmitBtn.disabled = false;
    entrySubmitBtn.textContent = "Write it down";
  }
});

function renderAiResponse(ai, mode) {
  aiResponseEl.hidden = false;
  if (mode === "reflect") {
    aiResponseEl.innerHTML = `
      <p class="reflection">${escapeHtml(ai.reflection)}</p>
      ${ai.noticedPattern ? `<p class="pattern">Noticed: ${escapeHtml(ai.noticedPattern)}</p>` : ""}
      <p class="question">${escapeHtml(ai.followUpQuestion)}</p>
      <div class="meta-row">
        <span class="tag">${escapeHtml(ai.mood)}</span>
        ${(ai.themes || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
      </div>
    `;
  } else {
    aiResponseEl.innerHTML = `
      <p class="reflection"><strong>Start here:</strong> ${escapeHtml(ai.microStep)}</p>
      ${
        ai.parkedForLater && ai.parkedForLater.length
          ? `<ul class="braindump-list">${ai.parkedForLater
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join("")}</ul>`
          : ""
      }
      <p class="question">${escapeHtml(ai.reframe)}</p>
    `;
  }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
async function loadEntries() {
  try {
    const { entries } = await apiFetch("/api/entries?limit=30");
    timelineEl.innerHTML = "";
    timelineEmpty.hidden = entries.length > 0;

    entries.forEach((entry) => {
      const li = document.createElement("li");
      const date = entry.createdAt ? formatDate(entry.createdAt) : "";
      const modeLabel = entry.mode === "reflect" ? "Reflect" : "Brain dump";

      li.innerHTML = `
        <div class="entry-meta"><span>${date}</span><span>${modeLabel}</span></div>
        <p class="entry-text">${escapeHtml(truncate(entry.text, 220))}</p>
        <details>
          <summary>Show MindEcho's response</summary>
        </details>
      `;
      const details = li.querySelector("details");
      const responseHolder = document.createElement("div");
      responseHolder.style.marginTop = "10px";
      details.appendChild(responseHolder);
      details.addEventListener(
        "toggle",
        () => {
          if (details.open && !responseHolder.dataset.filled) {
            responseHolder.dataset.filled = "1";
            const temp = document.createElement("div");
            temp.className = "ai-response";
            aiResponseElInto(temp, entry.ai, entry.mode);
            responseHolder.appendChild(temp);
          }
        },
        { once: false }
      );

      timelineEl.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load entries:", err);
  }
}

// Renders an AI response into an arbitrary container (used by the timeline,
// which needs many response cards, not just the one live at the top).
function aiResponseElInto(container, ai, mode) {
  if (mode === "reflect") {
    container.innerHTML = `
      <p class="reflection">${escapeHtml(ai.reflection)}</p>
      ${ai.noticedPattern ? `<p class="pattern">Noticed: ${escapeHtml(ai.noticedPattern)}</p>` : ""}
      <p class="question">${escapeHtml(ai.followUpQuestion)}</p>
    `;
  } else {
    container.innerHTML = `
      <p class="reflection"><strong>Start here:</strong> ${escapeHtml(ai.microStep)}</p>
      <p class="question">${escapeHtml(ai.reframe)}</p>
    `;
  }
}

// ---------------------------------------------------------------------------
// Trust circle (revocable share links)
// ---------------------------------------------------------------------------
createShareBtn.addEventListener("click", async () => {
  shareError.textContent = "";
  createShareBtn.disabled = true;
  createShareBtn.textContent = "Creating…";
  try {
    await apiFetch("/api/share", {
      method: "POST",
      body: JSON.stringify({
        entryCount: Number(shareEntryCount.value),
        expiresInHours: Number(shareExpiry.value),
      }),
    });
    loadShares();
  } catch (err) {
    shareError.textContent = err.message || "Could not create a share link.";
  } finally {
    createShareBtn.disabled = false;
    createShareBtn.textContent = "Create share link";
  }
});

async function loadShares() {
  try {
    const { shares } = await apiFetch("/api/shares");
    shareList.innerHTML = "";
    shares.forEach((share) => {
      const li = document.createElement("li");
      const expired = share.expiresAt && new Date(share.expiresAt).getTime() < Date.now();
      const link = `${location.origin}/share.html?id=${share.id}`;

      if (share.revoked) {
        li.innerHTML = `<span class="revoked">Revoked · ${share.entryCount} entries</span>`;
      } else if (expired) {
        li.innerHTML = `<span class="revoked">Expired · ${share.entryCount} entries</span>`;
      } else {
        li.innerHTML = `
          <span class="share-meta">${share.entryCount} entries · expires ${formatDate(share.expiresAt)}</span>
          <span class="share-actions">
            <button class="text-btn copy" type="button">Copy link</button>
            <button class="text-btn revoke" type="button">Revoke</button>
          </span>
        `;
        li.querySelector(".copy").addEventListener("click", async () => {
          await navigator.clipboard.writeText(link);
          li.querySelector(".copy").textContent = "Copied";
          setTimeout(() => (li.querySelector(".copy").textContent = "Copy link"), 1500);
        });
        li.querySelector(".revoke").addEventListener("click", async () => {
          await apiFetch(`/api/shares/${share.id}/revoke`, { method: "POST" });
          loadShares();
        });
      }
      shareList.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load shares:", err);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
