const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const db = require("./db");
const sessionManager = require("./session");

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

  const userPhone = message.from;
  const userText = message.text?.body || message.interactive?.button_reply?.title || "";
  const buttonId = message.interactive?.button_reply?.id || null;

  console.log(`User (${userPhone}): text="${userText}" buttonId="${buttonId}"`);

  try {
    const session = await sessionManager.getSession(userPhone);
    const vendor = await db.getVendor(userPhone);

    // Onboarding flow
    if (!vendor) {
      if (session.step === "onboarding_name") {
        // Save business name
        await db.createVendor(userPhone, userText);
        const updatedVendor = await db.getVendor(userPhone);
        const businessName = updatedVendor ? updatedVendor.name : userText;
        await sendText(userPhone, `Awesome, registered business: ${businessName}! 🎉`);
        
        session.step = "menu";
        await sessionManager.saveSession(userPhone, session);
        await handleMenu(userPhone, null, session);
      } else {
        // Trigger onboarding
        await sendText(userPhone, "Hi! Welcome to Aika.\n\nWhat's your business name?");
        await sessionManager.saveSession(userPhone, { step: 'onboarding_name' });
      }
      return res.sendStatus(200);
    }

    // Routing based on button actions
    if (buttonId) {
      if (buttonId === "btn_new_delivery" || buttonId === "btn_track" || buttonId === "btn_account") {
        await handleMenu(userPhone, buttonId, session);
      } else if (buttonId === "confirm_address" || buttonId === "edit_address") {
        if (buttonId === "confirm_address") {
          session.draftDelivery.pickupLabel = "Main Warehouse";
          session.draftDelivery.category = "General Package";
          session.draftDelivery.valueLabel = "Standard delivery";
          session.draftDelivery.cod = false;
          session.draftDelivery.codAmount = 0;

          session.step = "awaiting_confirmation";
          await sessionManager.saveSession(userPhone, session);
          await showDeliverySummary(userPhone, session.draftDelivery);
        } else if (buttonId === "edit_address") {
          await sendText(userPhone, "Please enter your customer's delivery address:");
          session.step = "awaiting_address_input";
          await sessionManager.saveSession(userPhone, session);
        }
      } else if (buttonId === "confirm_yes" || buttonId === "confirm_no") {
        await handleConfirmSummary(userPhone, buttonId, session);
      }
      return res.sendStatus(200);
    }

    // Normal text message handling based on conversational step
    if (session.step === "awaiting_address_input") {
      session.draftDelivery = { address: userText };
      session.step = "confirm_address_input";
      await sessionManager.saveSession(userPhone, session);
      
      await sendButtons(userPhone, `Address entered:\n${userText}\n\nIs this correct?`, [
        { id: "confirm_address", title: "Confirm Address" },
        { id: "edit_address",    title: "Edit Address" }
      ]);
    } else if (session.step === "confirm_address_input") {
      await sendButtons(userPhone, `Please select one of the options to proceed:\n\nAddress entered:\n${session.draftDelivery.address}`, [
        { id: "confirm_address", title: "Confirm Address" },
        { id: "edit_address",    title: "Edit Address" }
      ]);
    } else if (session.step === "awaiting_confirmation") {
      await showDeliverySummary(userPhone, session.draftDelivery);
    } else {
      // Default: show main menu
      await handleMenu(userPhone, null, session);
    }

  } catch (err) {
    console.error("Webhook processing error:", err);
  }

  res.sendStatus(200);
});

// Helper: Send Text Message
async function sendText(phone, text) {
  await sendMessage(phone, text);
}

// Helper: Send Button Message
async function sendButtons(to, text, buttons) {
  const formattedButtons = buttons.map(btn => ({
    type: "reply",
    reply: {
      id: btn.id,
      title: btn.title
    }
  }));

  await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: text
        },
        action: {
          buttons: formattedButtons
        }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// User-provided logic: Main menu handler
async function handleMenu(phone, input, session) {
  const vendor = await db.getVendor(phone);

  if (!vendor) {
    // First-time user — start onboarding
    await sendText(phone, `Hi! Welcome to Aika.\n\nWhat's your business name?`);
    await sessionManager.saveSession(phone, { step: 'onboarding_name' });
    return;
  }

  if (input === 'btn_new_delivery') {
    await sendText(phone, "Please enter your customer's delivery address:");
    session.step = 'awaiting_address_input';
    session.draftDelivery = {};
    await sessionManager.saveSession(phone, session);
    return;
  }

  // Default: show main menu
  const greeting = vendor.name ? `Hi ${vendor.name} 👋` : `Hi!`;
  await sendButtons(phone, `${greeting}\n\nWhat do you need?`, [
    { id: 'btn_new_delivery', title: 'New delivery' },
    { id: 'btn_track',        title: 'Track order' },
    { id: 'btn_account',      title: 'My account' }
  ]);
}

// User-provided logic: Show delivery summary
async function showDeliverySummary(phone, d) {
  const fee = await calculateZoneFee(d.pickupLat, d.pickupLng, d.lat, d.lng);
  const cod = d.cod ? `\n• COD to collect: ₦${d.codAmount.toLocaleString()}` : '';

  const summary = [
    '📦 Delivery summary:\n',
    `• Pickup: ${d.pickupLabel}`,
    `• Drop: ${d.address}`,
    `• Item: ${d.category} · ${d.valueLabel}`,
    cod,
    `• Delivery fee: ₦${fee}`,
    '\nConfirm?'
  ].join('\n');

  await sendButtons(phone, summary, [
    { id: 'confirm_yes', title: 'Confirm ✓' },
    { id: 'confirm_no',  title: 'Cancel' }
  ]);
}

// User-provided logic: Handle confirmation of summary
async function handleConfirmSummary(phone, buttonId, session) {
  if (buttonId === 'confirm_no') {
    await sessionManager.clearSession(phone);
    await sendText(phone, 'Cancelled. Send "hi" to start again.');
    return;
  }

  const trackingCode = generateTrackingCode();

  // Create delivery record
  const delivery = await db.createDelivery({
    vendorPhone: phone,
    ...session.draftDelivery,
    status: 'searching',
    trackingCode: trackingCode
  });

  const destinationAddress = session.draftDelivery.address || "Lagos, Nigeria";
  const trackingLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destinationAddress)}`;

  const message = [
    `🎉 Delivery created successfully!`,
    `• Reference Number: ${trackingCode}`,
    `• Status: Searching for nearby riders... 🚚`,
    `• Real-time Tracking: ${trackingLink}`
  ].join('\n');

  await sendText(phone, message);

  await sessionManager.clearSession(phone);
}

// Helper: Calculate zone fee
async function calculateZoneFee(pickupLat, pickupLng, lat, lng) {
  return 1500;
}

// Helper: Generate tracking code
function generateTrackingCode() {
  return "AK" + Math.floor(100000 + Math.random() * 900000);
}

// Helper: Dispatch rider
async function dispatchRider(delivery) {
  console.log("Dispatching rider for delivery:", delivery);
}

// Send simple WhatsApp message
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

// Parse delivery with Gemini API
async function parseDelivery(text) {
  const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

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

  console.log("RAW GEMINI OUTPUT:", textOutput);

  // Gemini sometimes wraps JSON in text, so clean it:
  const cleaned = textOutput.replace(/```json|```/g, "").trim();

  return JSON.parse(cleaned);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Aika bot running on port", PORT);
});