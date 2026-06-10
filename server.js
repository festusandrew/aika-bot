const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
app.use(express.json());

// Health check (Render uses this)
app.get("/", (req, res) => {
    res.send("Aika bot is live 🚀");
});

// WhatsApp webhook verification
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === "aika_verify") {
        return res.status(200).send(challenge);
    }

    res.sendStatus(403);
});

// Receive WhatsApp messages
app.post("/webhook", async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const userText = message.text?.body;
  const userPhone = message.from;

  console.log("User said:", userText);

  // SIMPLE REPLY LOGIC (NO AI YET)
  let reply = "";

  if (userText.toLowerCase().includes("hello")) {
    reply = "Hi 👋 Welcome to Aika. What do you want to send today?";
  } else if (userText.toLowerCase().includes("send")) {
    reply = "Got it 👍 Where do we pick up your package from?";
  } else {
    reply = "I can help you with deliveries 🚚. Do you want to send a package?";
  }

  await sendMessage(userPhone, reply);

  res.sendStatus(200);
});

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function parseDelivery(text) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `
You are Aika, a logistics assistant for a delivery company in Nigeria.

Extract delivery information from this message:

Return ONLY valid JSON in this format:
{
  "intent": "create_delivery",
  "pickup": "",
  "dropoff": "",
  "item": "",
  "needs_more_info": true/false
}

User message: "${text}"
`;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const textOutput = response.text();

  // Gemini sometimes wraps JSON in text, so clean it:
  const cleaned = textOutput.replace(/```json|```/g, "").trim();

  return JSON.parse(cleaned);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Aika bot running on port", PORT);
});