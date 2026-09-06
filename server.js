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

    let aiResult;
    if (mode === "reflect") {
      const memoryContext = await buildMemoryContext(req.uid);
      aiResult = await reflectOnEntry({ text, memoryContext });
    } else {
      aiResult = await processBrainDump({ text });
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

    const { summary, highlightThemes } = await summarizeForShare({ entries });

    const shareId = crypto.randomBytes(9).toString("base64url");
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    await db.collection("shares").doc(shareId).set({
      ownerUid: req.uid,
      summary,
      highlightThemes: highlightThemes || [],
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
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    const shares = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        entryCount: data.entryCount,
        revoked: !!data.revoked,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null,
        expiresAt: data.expiresAt?.toDate ? data.expiresAt.toDate().toISOString() : null,
      };
    });

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

app.get("/healthz", (req, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`MindEcho listening on port ${PORT}`);
});
