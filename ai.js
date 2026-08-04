const { GoogleGenerativeAI } = require("@google/generative-ai");

// The AI layer steps in when guided button flow doesn't handle a message
// (free text at the menu, or an unrecognized reply). It never replaces the flow.
//
// understandMessage() makes a Gemini call that both classifies the intent
// and, where relevant, extracts delivery fields or drafts a best-effort answer.
// On any failure (missing key, network, bad JSON) it returns { intent: "unknown" }
// so the bot always falls back safely to the menu instead of crashing.

const MODEL_CANDIDATES = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
  "gemini-1.5-flash"
];

let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} else {
  console.warn("No GEMINI_API_KEY set. AI understanding disabled; bot runs on buttons only.");
}

// Grounding facts so best-effort answers stay close to how Aika actually works.
const SERVICE_FACTS = `
Aika is a WhatsApp logistics assistant for delivery vendors in Nigeria (Lagos & Kaduna area).
How it works:
- Vendors create deliveries by giving a drop-off address, the customer's phone number,
  what is being delivered, and whether the customer pays cash on delivery or has prepaid.
- The pickup point is always the vendor's registered business location.
- Each delivery gets a tracking code like AK123456 used to check status.
- A rider is assigned automatically; the vendor can cancel only until the rider picks up.
Delivery fees are flat, based on package size, in Nigerian Naira:
- Small (fits in a bag): 1500
- Medium (medium box): 2500
- Large (heavy or bulky): 4000
Food and clothing deliveries use the Small fee.
`;

function buildPrompt(text) {
  return `
You are Aika, a friendly logistics assistant for delivery vendors in Nigeria.

Use these facts about the service when answering:
${SERVICE_FACTS}

Read the vendor's message and respond with ONLY a valid JSON object, no markdown, in this exact shape:
{
  "intent": "create_delivery | track_order | cancel | question | greeting | unknown",
  "delivery": {
    "address": "",
    "customerPhone": "",
    "item": "",
    "codAmount": null
  },
  "trackingCode": "",
  "answer": ""
}

Rules:
- "create_delivery": the vendor wants to send something. Fill any delivery fields you can
  extract; leave unknown fields as empty strings (or null for codAmount). Do not invent values.
- "track_order": the vendor wants the status of an order. Put any code like AK123456 in trackingCode.
- "cancel": the vendor wants to cancel, stop, abort, exit, or scrap the current delivery placement or operation.
- "question": the vendor is asking something (fees, coverage, how it works, etc.). Put a helpful,
  concise best-effort answer in "answer". Always attempt an answer even if unsure, and keep it accurate
  to the facts above where they apply.
- "greeting": a greeting or small talk. Put a short friendly reply in "answer".
- "unknown": you cannot tell. Leave answer empty.
- Return only the JSON. No backticks, no commentary.

Vendor message: "${text}"
`;
}

function normalizeResult(raw) {
  const out = {
    intent: "unknown",
    delivery: { address: "", customerPhone: "", item: "", codAmount: null },
    trackingCode: "",
    answer: ""
  };
  if (!raw || typeof raw !== "object") return out;

  const validIntents = ["create_delivery", "track_order", "cancel", "question", "greeting", "unknown"];
  if (validIntents.includes(raw.intent)) out.intent = raw.intent;

  if (raw.delivery && typeof raw.delivery === "object") {
    out.delivery.address = typeof raw.delivery.address === "string" ? raw.delivery.address.trim() : "";
    out.delivery.item = typeof raw.delivery.item === "string" ? raw.delivery.item.trim() : "";
    out.delivery.customerPhone = typeof raw.delivery.customerPhone === "string" ? raw.delivery.customerPhone.trim() : "";
    const amt = raw.delivery.codAmount;
    out.delivery.codAmount = typeof amt === "number" && !isNaN(amt) && amt >= 0 ? amt : null;
  }

  if (typeof raw.trackingCode === "string") out.trackingCode = raw.trackingCode.trim().toUpperCase();
  if (typeof raw.answer === "string") out.answer = raw.answer.trim();

  return out;
}

async function understandMessage(text) {
  if (!genAI || !text || !text.trim()) {
    return normalizeResult(null);
  }

  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(buildPrompt(text));
      const response = await result.response;
      const textOutput = response.text();

      let cleaned = textOutput.replace(/```json|```/g, "").trim();
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
      }

      const parsed = JSON.parse(cleaned);
      return normalizeResult(parsed);
    } catch (err) {
      lastError = err;
      // If model not found (404), continue to next model candidate
      if (err.message && err.message.includes("404")) {
        continue;
      }
      // For quota errors (429) or other errors, log and try next or break
      console.warn(`Gemini model ${modelName} warning:`, err.message || err);
    }
  }

  console.error("AI understandMessage failed across all candidates:", lastError?.message || lastError);
  return normalizeResult(null);
}

module.exports = { understandMessage };

