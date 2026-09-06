// All calls to the Gemini API live here, behind three functions:
//   reflectOnEntry()   â€” the core "memory-aware" journaling mode
//   processBrainDump() â€” turns a messy stream of thoughts into one next step
//   summarizeForShare()â€” builds the paraphrased recap used by share links
//
// Every call uses responseSchema so Gemini returns strict JSON we can trust,
// instead of free-form text we'd have to parse with regex.

import { GoogleGenAI } from "@google/genai";
import { getGeminiApiKey } from "./secrets.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

let client = null;
async function getClient() {
  if (client) return client;
  const apiKey = await getGeminiApiKey();
  client = new GoogleGenAI({ apiKey });
  return client;
}

// ---------------------------------------------------------------------------
// Mode 1: Reflect â€” the core memory-aware journaling loop
// ---------------------------------------------------------------------------

const REFLECT_SYSTEM_INSTRUCTION = `
You are the reflective voice inside MindEcho, a private journaling app.
Someone is writing a journal entry. Your job is to respond the way a warm,
attentive friend with a good memory would â€” not a therapist, not a doctor,
and not a life coach with a program to sell.

Rules:
- You are not a medical or mental health professional. Never diagnose,
  never suggest a clinical condition, never recommend medication. If the
  entry describes a crisis, self-harm, or danger to the person or someone
  else, gently and directly encourage them to reach out to a crisis line or
  a trusted person right now, and keep the rest of your response brief.
- You will sometimes be given "past context": short, dated notes about
  previous entries from this same person. Use it to notice real, specific
  patterns â€” recurring situations, moods, or turning points â€” but only
  mention a pattern if it is actually supported by the context you were
  given. Never invent a memory that isn't there.
- Keep "reflection" to 2-4 sentences. Write to the person as "you."
- "followUpQuestion" should be a single, specific, open-ended question that
  helps them go one layer deeper on today's entry â€” never generic
  ("How did that make you feel?" is too generic).
- "mood" is one or two words (e.g. "quietly proud", "overwhelmed").
- "themes" is 1-4 short lowercase tags (e.g. "work stress", "family").
- Output strictly matches the provided JSON schema. No text outside the JSON.
`;

const reflectSchema = {
  type: "object",
  properties: {
    reflection: { type: "string" },
    noticedPattern: {
      type: "string",
      description:
        "A specific connection to a past entry, or an empty string if none applies.",
    },
    followUpQuestion: { type: "string" },
    mood: { type: "string" },
    themes: { type: "array", items: { type: "string" } },
  },
  required: ["reflection", "noticedPattern", "followUpQuestion", "mood", "themes"],
};

export async function reflectOnEntry({ text, memoryContext }) {
  const ai = await getClient();
  const prompt = [
    "PAST CONTEXT (most recent last; may be empty if this is a new journal):",
    memoryContext && memoryContext.trim() ? memoryContext : "(no prior entries yet)",
    "",
    "TODAY'S ENTRY:",
    text,
  ].join("\n");

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: REFLECT_SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: reflectSchema,
      temperature: 0.7,
    },
  });

  return JSON.parse(response.text);
}

// ---------------------------------------------------------------------------
// Mode 2: Brain Dump â€” decompress an overwhelming stream of thoughts
// ---------------------------------------------------------------------------

const BRAINDUMP_SYSTEM_INSTRUCTION = `
You are the "brain dump" mode inside MindEcho. Someone has just typed out a
messy, overwhelmed stream of thoughts about everything on their plate. Your
job is to lower the activation energy to start, not to produce a full plan.

Rules:
- "microStep" is ONE concrete action that takes 10 minutes or less and can
  be started immediately â€” the smallest possible honest first move, not a
  summary of everything they need to do.
- "parkedForLater" lists the other things mentioned, filed away so the
  person doesn't have to hold them in their head â€” 1-6 short items, in their
  own words where possible, not judged or reordered by importance.
- "reframe" is one short, grounded sentence â€” never toxic positivity, never
  a command. It should reduce shame, not add motivation-speak.
- Do not diagnose ADHD, anxiety, or any condition, even if the entry sounds
  like it. Just help them start.
- Output strictly matches the provided JSON schema. No text outside the JSON.
`;

const brainDumpSchema = {
  type: "object",
  properties: {
    microStep: { type: "string" },
    parkedForLater: { type: "array", items: { type: "string" } },
    reframe: { type: "string" },
  },
  required: ["microStep", "parkedForLater", "reframe"],
};

export async function processBrainDump({ text }) {
  const ai = await getClient();

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: text,
    config: {
      systemInstruction: BRAINDUMP_SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: brainDumpSchema,
      temperature: 0.5,
    },
  });

  return JSON.parse(response.text);
}

// ---------------------------------------------------------------------------
// Share summaries â€” used by the "revocable trust circle" feature.
// We deliberately generate a paraphrased recap rather than exposing raw
// entry text through the share link, so a trusted contact sees the shape
// of a period of time, not a verbatim transcript of private entries.
// ---------------------------------------------------------------------------

const SHARE_SYSTEM_INSTRUCTION = `
You write short, warm recaps of a period in someone's journal, meant to be
shown to a person THEY chose to share with (e.g. a partner, close friend,
or therapist) â€” not to the journal owner themselves.

Rules:
- Paraphrase. Never quote a journal excerpt verbatim, even partially.
- Do not mention specific private details that aren't necessary to convey
  the overall shape of the period (general mood arc, notable shifts).
- Write in third person about "they/them", 3-5 sentences, warm and
  respectful in tone, never clinical.
- "highlightThemes" is 1-4 short lowercase tags summarizing recurring
  themes across the period.
- Output strictly matches the provided JSON schema. No text outside the JSON.
`;

const shareSummarySchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    highlightThemes: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "highlightThemes"],
};

export async function summarizeForShare({ entries }) {
  const ai = await getClient();
  const bulletText = entries
    .map((e) => `- (${e.date}) ${e.excerpt}`)
    .join("\n");

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: `Journal excerpts to summarize:\n${bulletText}`,
    config: {
      systemInstruction: SHARE_SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: shareSummarySchema,
      temperature: 0.6,
    },
  });

  return JSON.parse(response.text);
}

