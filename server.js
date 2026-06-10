const express = require("express");
const axios = require("axios");

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
app.post("/webhook", (req, res) => {
    console.log("Incoming message:", JSON.stringify(req.body, null, 2));
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Aika bot running on port", PORT);
});