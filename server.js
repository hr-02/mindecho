import "dotenv/config";
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import admin from "./src/firebaseAdmin.js";
import {
  reflectOnEntry,
  processBrainDump,
  summarizeForShare,
} from "./src/gemini.js";
import { encryptApiKey, decryptApiKey } from "./src/vault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const db = admin.firestore();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Auth middleware — every private route requires a valid Firebase ID token.
// The frontend gets this token from firebase.auth().currentUser.getIdToken()
// and sends it as "Authorization: Bearer <token>".
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Encrypted User Key Vault — retrieves and decrypts user's key in memory only
// ---------------------------------------------------------------------------
async function getUserApiKey(uid) {
  try {
    const doc = await db.collection("user_vault").doc(uid).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (!data.encryptedKey) return null;
    return decryptApiKey(data.encryptedKey);
  } catch (err) {
    console.error("Error retrieving user API key from vault:", err);
    return null;
  }
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: "Missing bearer token." });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    console.error("Token verification failed:", err.message);
    res.status(401).json({ error: "Invalid or expired session. Sign in again." });
  }
}

// ---------------------------------------------------------------------------
// Memory context — this is the core of the "memory-aware" feature. It pulls
// a short, cheap summary of recent entries (already-computed mood/themes,
// not a fresh AI call) so Gemini can reference real history.
// ---------------------------------------------------------------------------

async function buildMemoryContext(uid, limit = 8) {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("entries")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  if (snap.empty) return "";

  const lines = [];
  snap.forEach((doc) => {
    const d = doc.data();
    const date = d.createdAt?.toDate
      ? d.createdAt.toDate().toISOString().slice(0, 10)
      : "unknown date";
    const mood = d.ai?.mood ? ` [mood: ${d.ai.mood}]` : "";
    const raw = (d.text || "").replace(/\s+/g, " ").trim();
    const excerpt = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
    lines.push(`- ${date}${mood}: ${excerpt}`);
  });

  // oldest -> newest reads more naturally to the model
  return lines.reverse().join("\n");
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

app.post("/api/entries", requireAuth, async (req, res) => {
  try {
    const { text, mode } = req.body || {};

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Entry text is required." });
    }
    if (!["reflect", "braindump"].includes(mode)) {
      return res
        .status(400)
        .json({ error: "mode must be 'reflect' or 'braindump'." });
    }
    if (text.length > 8000) {
      return res.status(400).json({ error: "Entry is too long (max 8000 characters)." });
    }

    const userApiKey = await getUserApiKey(req.uid);
    let aiResult;
    if (mode === "reflect") {
      const memoryContext = await buildMemoryContext(req.uid);
      aiResult = await reflectOnEntry({ text, memoryContext, userApiKey });
    } else {
      aiResult = await processBrainDump({ text, userApiKey });
    }

    const entryRef = db
      .collection("users")
      .doc(req.uid)
      .collection("entries")
      .doc();

    await entryRef.set({
      text,
      mode,
      ai: aiResult,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ id: entryRef.id, mode, ai: aiResult });
  } catch (err) {
    console.error("POST /api/entries failed:", err);
    const msg = err?.message || String(err);
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded")) {
      return res.status(429).json({
        error: "Gemini API quota exceeded for the current key. Please set your own free Google AI Studio key using the top banner.",
      });
    }
    if (msg.includes("API key not valid") || msg.includes("API_KEY_INVALID")) {
      return res.status(400).json({
        error: "The provided Gemini API key is invalid. Please check your key in the top banner.",
      });
    }
    res.status(500).json({ error: "Something went wrong processing that entry." });
  }
});

app.get("/api/entries", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const snap = await db
      .collection("users")
      .doc(req.uid)
      .collection("entries")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const entries = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        text: data.text,
        mode: data.mode,
        ai: data.ai,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null,
      };
    });

    res.json({ entries });
  } catch (err) {
    console.error("GET /api/entries failed:", err);
    res.status(500).json({ error: "Could not load entries." });
  }
});

// ---------------------------------------------------------------------------
// Revocable Trust Circle — expiring, paraphrased, read-only share links.
// The "shares" collection is never touched by client-side Firestore SDKs;
// it's only ever read/written by this server via the Admin SDK, so no
// Firestore security rule needs to expose it to the public.
// ---------------------------------------------------------------------------

app.post("/api/share", requireAuth, async (req, res) => {
  try {
    const { entryCount = 10, expiresInHours = 24 } = req.body || {};
    const limit = Math.min(Math.max(parseInt(entryCount, 10) || 10, 1), 30);
    const hours = Math.min(Math.max(parseInt(expiresInHours, 10) || 24, 1), 24 * 30);

    const snap = await db
      .collection("users")
      .doc(req.uid)
      .collection("entries")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    if (snap.empty) {
      return res.status(400).json({ error: "Write at least one entry before sharing." });
    }

    const entries = snap.docs
      .map((doc) => {
        const data = doc.data();
        const date = data.createdAt?.toDate
          ? data.createdAt.toDate().toISOString().slice(0, 10)
          : "unknown";
        return { date, excerpt: (data.text || "").slice(0, 200) };
      })
      .reverse();

    const userApiKey = await getUserApiKey(req.uid);
    let summaryData;
    try {
      summaryData = await summarizeForShare({ entries, userApiKey });
    } catch (geminiErr) {
      console.warn("Gemini summarizeForShare failed, using fallback summary:", geminiErr?.message || geminiErr);
      summaryData = {
        summary: `A reflective recap of ${entries.length} recent journal entries, highlighting personal insights, mindfulness, and ongoing personal growth.`,
        highlightThemes: ["Reflection", "Mindfulness", "Personal Growth"],
      };
    }

    const shareId = crypto.randomBytes(9).toString("base64url");
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    await db.collection("shares").doc(shareId).set({
      ownerUid: req.uid,
      summary: summaryData.summary,
      highlightThemes: summaryData.highlightThemes || [],
      entryCount: entries.length,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      revoked: false,
    });

    res.json({ shareId, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error("POST /api/share failed:", err);
    res.status(500).json({ error: "Could not create a share link." });
  }
});

app.get("/api/shares", requireAuth, async (req, res) => {
  try {
    const snap = await db
      .collection("shares")
      .where("ownerUid", "==", req.uid)
      .get();

    const shares = snap.docs
      .map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          entryCount: data.entryCount,
          revoked: !!data.revoked,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null,
          expiresAt: data.expiresAt?.toDate ? data.expiresAt.toDate().toISOString() : null,
          _rawCreatedAt: data.createdAt?.toDate ? data.createdAt.toDate().getTime() : 0,
        };
      })
      .sort((a, b) => b._rawCreatedAt - a._rawCreatedAt)
      .slice(0, 20)
      .map(({ _rawCreatedAt, ...rest }) => rest);

    res.json({ shares });
  } catch (err) {
    console.error("GET /api/shares failed:", err);
    res.status(500).json({ error: "Could not load your share links." });
  }
});

app.post("/api/shares/:id/revoke", requireAuth, async (req, res) => {
  try {
    const ref = db.collection("shares").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Share link not found." });
    if (doc.data().ownerUid !== req.uid) {
      return res.status(403).json({ error: "That share link doesn't belong to you." });
    }
    await ref.update({ revoked: true });
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/shares/:id/revoke failed:", err);
    res.status(500).json({ error: "Could not revoke that share link." });
  }
});

// Public, unauthenticated — this is the link a trusted contact opens.
app.get("/api/share/:id", async (req, res) => {
  try {
    const doc = await db.collection("shares").doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "This link doesn't exist." });
    }
    const data = doc.data();
    if (data.revoked) {
      return res.status(410).json({ error: "This link has been revoked by its owner." });
    }
    const expiresAt = data.expiresAt?.toDate ? data.expiresAt.toDate() : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: "This link has expired." });
    }

    res.json({
      summary: data.summary,
      highlightThemes: data.highlightThemes || [],
      entryCount: data.entryCount,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
  } catch (err) {
    console.error("GET /api/share/:id failed:", err);
    res.status(500).json({ error: "Could not load this shared recap." });
  }
});


// ---------------------------------------------------------------------------
// Encrypted Key Vault Management Routes
// ---------------------------------------------------------------------------
app.get("/api/user/key-status", requireAuth, async (req, res) => {
  try {
    const doc = await db.collection("user_vault").doc(req.uid).get();
    if (!doc.exists || !doc.data().encryptedKey) {
      return res.json({ hasCustomKey: false });
    }
    const data = doc.data();
    res.json({
      hasCustomKey: true,
      keyHint: data.keyHint || "...configured",
      updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : null,
    });
  } catch (err) {
    console.error("GET /api/user/key-status failed:", err);
    res.status(500).json({ error: "Could not check API key status." });
  }
});

app.post("/api/user/key", requireAuth, async (req, res) => {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
      return res.status(400).json({ error: "Please enter a valid Gemini API key (at least 10 characters)." });
    }
    const trimmed = apiKey.trim();
    const encryptedKey = encryptApiKey(trimmed);
    const keyHint = "..." + trimmed.slice(-4);

    await db.collection("user_vault").doc(req.uid).set({
      encryptedKey,
      keyHint,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ ok: true, keyHint });
  } catch (err) {
    console.error("POST /api/user/key failed:", err);
    res.status(500).json({ error: "Could not save encrypted API key." });
  }
});

app.delete("/api/user/key", requireAuth, async (req, res) => {
  try {
    await db.collection("user_vault").doc(req.uid).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/user/key failed:", err);
    res.status(500).json({ error: "Could not remove API key." });
  }
});

app.get("/healthz", (req, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`MindEcho listening on port ${PORT}`);
});

