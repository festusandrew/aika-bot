const express = require("express");
const axios = require("axios");

const db = require("./db");
const sessionManager = require("./session");
const ai = require("./ai");

const app = express();
app.use(express.json());

// Health check (Render uses this)
app.get("/", (req, res) => {
  res.send("Aika bot is live 🚀");
});

// Rider app posts its live GPS here so the tracking link points at the rider.
// Body: { trackingCode, lat, lng }. If RIDER_API_KEY is set, the rider app must
// send it as the "x-rider-key" header; if unset, the check is skipped.
app.post("/rider/location", async (req, res) => {
  try {
    if (process.env.RIDER_API_KEY && req.get("x-rider-key") !== process.env.RIDER_API_KEY) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const { trackingCode, lat, lng } = req.body || {};
    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (!trackingCode || typeof trackingCode !== "string") {
      return res.status(400).json({ error: "trackingCode is required" });
    }
    if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90 ||
        !Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
      return res.status(400).json({ error: "lat/lng must be valid coordinates" });
    }

    const updated = await db.updateRiderLocation(trackingCode.trim().toUpperCase(), latNum, lngNum);
    if (!updated) {
      return res.status(404).json({ error: "delivery not found" });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Rider location update error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// Rider app signals delivery status update (delivered / failed).
// Body: { trackingCode, status: "delivered" | "failed", reason?: string }
app.post("/rider/status", async (req, res) => {
  try {
    if (process.env.RIDER_API_KEY && req.get("x-rider-key") !== process.env.RIDER_API_KEY) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const { trackingCode, status, reason } = req.body || {};
    if (!trackingCode || typeof trackingCode !== "string") {
      return res.status(400).json({ error: "trackingCode is required" });
    }
    if (status !== "delivered" && status !== "failed") {
      return res.status(400).json({ error: "status must be 'delivered' or 'failed'" });
    }

    const updated = await handleRiderStatusUpdate(trackingCode, status, reason);
    if (!updated) {
      return res.status(404).json({ error: "delivery not found" });
    }

    return res.status(200).json({ ok: true, status: updated.status });
  } catch (err) {
    console.error("Rider status update error:", err);
    return res.status(500).json({ error: "internal error" });
  }
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
  console.log("Webhook reached successfully");

  try {
    const session = await sessionManager.getSession(userPhone);
    const vendor = await db.getVendor(userPhone);

    // Onboarding flow
    if (!vendor) {
      if (session.step === "onboarding_name") {
        // Hold business name in session, then collect location before creating the vendor
        session.onboardingName = userText;
        session.step = "onboarding_location";
        await sessionManager.saveSession(userPhone, session);
        await sendText(userPhone, "Great! What's your business location? This will be used as the pickup point for your deliveries (e.g. 12 Allen Avenue, Ikeja, Lagos):");
      } else if (session.step === "onboarding_location") {
        // Save business name + location
        const businessName = session.onboardingName || "";
        const location = userText;
        await db.createVendor(userPhone, businessName, location);
        const updatedVendor = await db.getVendor(userPhone);
        const savedName = updatedVendor ? updatedVendor.name : businessName;
        await sendText(userPhone, `Awesome, registered business: ${savedName}! 🎉\n\nPickup location: ${location}`);

        delete session.onboardingName;
        session.step = "menu";
        await sessionManager.saveSession(userPhone, session);
        await handleMenu(userPhone, null, session);
      } else {
        // Trigger onboarding
        console.log("Attempting to send onboarding message...");
        await sendText(userPhone, "Hi! Welcome to Aika.\n\nWhat's your business name?");
        console.log("Onboarding message sent.");
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
          // If the AI already captured a customer phone, skip straight to category
          // instead of re-asking for it.
          const draft = session.draftDelivery || {};
          const phoneDigits = draft.customerPhone ? (draft.customerPhone.match(/\d/g) || []).length : 0;
          if (phoneDigits >= 5) {
            session.step = "awaiting_category";
            await sessionManager.saveSession(userPhone, session);
            await sendButtons(userPhone, "What is to be delivered?", [
              { id: "cat_food", title: "Food" },
              { id: "cat_clothing", title: "Clothing" },
              { id: "cat_others", title: "Others" }
            ]);
          } else {
            session.step = "awaiting_customer_phone";
            await sessionManager.saveSession(userPhone, session);
            await sendText(userPhone, "Please enter the customer's phone number for the rider to call (e.g. 08012345678):");
          }
        } else if (buttonId === "edit_address") {
          await sendText(userPhone, "Please enter your customer's delivery address:");
          session.step = "awaiting_address_input";
          await sessionManager.saveSession(userPhone, session);
        }
      } else if (buttonId.startsWith("cat_")) {
        let category = "Others";
        if (buttonId === "cat_food") category = "Food";
        else if (buttonId === "cat_clothing") category = "Clothing";

        session.draftDelivery.category = category;

        if (category === "Others") {
          session.step = "awaiting_package_size";
          await sessionManager.saveSession(userPhone, session);
          await sendButtons(userPhone, "Please select the size of the delivery:", [
            { id: "size_small", title: "Small (fits in bag)" },
            { id: "size_medium", title: "Medium (medium box)" },
            { id: "size_large", title: "Large (heavy/bulky)" }
          ]);
        } else {
          session.step = "awaiting_payment_method";
          await sessionManager.saveSession(userPhone, session);
          await sendButtons(userPhone, "Should the rider collect the cost of the item from the customer upon delivery?", [
            { id: "pay_prepaid", title: "Customer has paid" },
            { id: "pay_cod", title: "Yes, collect cash" }
          ]);
        }
      } else if (buttonId.startsWith("size_")) {
        let size = "Small";
        if (buttonId === "size_medium") size = "Medium";
        else if (buttonId === "size_large") size = "Large";

        session.draftDelivery.size = size;
        session.step = "awaiting_payment_method";
        await sessionManager.saveSession(userPhone, session);
        await sendButtons(userPhone, "Should the rider collect the cost of the item from the customer upon delivery?", [
          { id: "pay_prepaid", title: "Customer has paid" },
          { id: "pay_cod", title: "Yes, collect cash" }
        ]);
      } else if (buttonId === "pay_prepaid" || buttonId === "pay_cod") {
        if (buttonId === "pay_prepaid") {
          session.draftDelivery.cod = false;
          session.draftDelivery.codAmount = 0;
          session.step = "awaiting_confirmation";
          await sessionManager.saveSession(userPhone, session);
          await showDeliverySummary(userPhone, session.draftDelivery, session);
        } else if (buttonId === "pay_cod") {
          await sendText(userPhone, "What is the cost of the item to be collected? (Enter only the item price, e.g. 5000. Do not include the delivery fee):");
          session.step = "awaiting_cod_amount";
          await sessionManager.saveSession(userPhone, session);
        }
      } else if (buttonId === "add_stop") {
        // Queue the current dropoff and start collecting the next one. Pickup stays the vendor's location.
        if (!Array.isArray(session.batch)) session.batch = [];
        session.batch.push(session.draftDelivery);
        session.draftDelivery = {};
        session.step = "awaiting_address_input";
        await sessionManager.saveSession(userPhone, session);
        await sendText(userPhone, `Delivery ${session.batch.length} saved. Please enter the delivery address for the next one:`);
      } else if (buttonId === "confirm_yes" || buttonId === "confirm_no") {
        await handleConfirmSummary(userPhone, buttonId, session);
      } else if (buttonId === "btn_main_menu") {
        await sessionManager.clearSession(userPhone);
        await handleMenu(userPhone, null, session);
      } else if (buttonId.startsWith("cancel_del_")) {
        // May be a single id or a comma-separated batch handled by one rider
        const deliveryIds = buttonId.replace("cancel_del_", "").split(",").filter(Boolean);
        const cancelledRefs = [];
        const blockedRefs = [];

        for (const deliveryId of deliveryIds) {
          const { result, delivery } = await db.cancelDelivery(deliveryId);
          const ref = delivery
            ? (delivery.tracking_code || delivery.trackingCode || deliveryId)
            : deliveryId;
          if (result === 'cancelled') {
            cancelledRefs.push(ref);
          } else if (result === 'not_cancellable') {
            blockedRefs.push(ref);
          }
        }

        const lines = [];
        if (cancelledRefs.length > 0) {
          lines.push(cancelledRefs.length > 1 ? `✕ ${cancelledRefs.length} Deliveries Cancelled` : `✕ Delivery Cancelled`);
          lines.push(`• Reference: ${cancelledRefs.join(", ")}`);
          lines.push(`• Status: The rider has been notified and the order is cancelled.`);
        }
        if (blockedRefs.length > 0) {
          if (lines.length > 0) lines.push('');
          lines.push(blockedRefs.length > 1 ? `⚠️ Could not cancel ${blockedRefs.length} deliveries` : `⚠️ Could not cancel this delivery`);
          lines.push(`• Reference: ${blockedRefs.join(", ")}`);
          lines.push(`• The rider has already picked up and is on the way to the drop-off, so it can no longer be cancelled.`);
        }
        if (lines.length === 0) {
          lines.push("Failed to cancel delivery. Please contact support.");
        }
        await sendText(userPhone, lines.join('\n'));
      } else if (buttonId.startsWith("rate_")) {
        // Format: rate_5_BATCH-123456 or rate_5_AK123456
        const parts = buttonId.split("_");
        const score = parseInt(parts[1], 10) || 5;
        const batchRef = parts.slice(2).join("_");

        await db.updateBatchRating(batchRef, score);

        const stars = "⭐".repeat(score);
        await sendText(userPhone, `Thank you for your rating! ${stars} (${score}/5) saved for the rider.\n\nYour order is now fully finalized! Send "hi" anytime to create a new delivery.`);
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
        { id: "edit_address", title: "Edit Address" }
      ]);
    } else if (session.step === "confirm_address_input") {
      await sendButtons(userPhone, `Please select one of the options to proceed:\n\nAddress entered:\n${session.draftDelivery.address}`, [
        { id: "confirm_address", title: "Confirm Address" },
        { id: "edit_address", title: "Edit Address" }
      ]);
    } else if (session.step === "awaiting_customer_phone") {
      const inputPhone = userText.trim();
      const digitCount = (inputPhone.match(/\d/g) || []).length;
      if (digitCount < 5) {
        await sendText(userPhone, "Invalid phone number. Please enter a valid customer phone number (e.g. 08012345678):");
      } else {
        session.draftDelivery.customerPhone = inputPhone;
        session.step = "awaiting_category";
        await sessionManager.saveSession(userPhone, session);
        await sendButtons(userPhone, "What is to be delivered?", [
          { id: "cat_food", title: "Food" },
          { id: "cat_clothing", title: "Clothing" },
          { id: "cat_others", title: "Others" }
        ]);
      }
    } else if (session.step === "awaiting_category") {
      const category = userText.trim();
      session.draftDelivery.category = category;

      const lowerCat = category.toLowerCase();
      if (lowerCat !== "food" && lowerCat !== "clothing") {
        session.step = "awaiting_package_size";
        await sessionManager.saveSession(userPhone, session);
        await sendButtons(userPhone, "Please select the size of the delivery:", [
          { id: "size_small", title: "Small (fits in bag)" },
          { id: "size_medium", title: "Medium (medium box)" },
          { id: "size_large", title: "Large (heavy/bulky)" }
        ]);
      } else {
        session.draftDelivery.category = lowerCat === "food" ? "Food" : "Clothing";
        session.step = "awaiting_payment_method";
        await sessionManager.saveSession(userPhone, session);
        await sendButtons(userPhone, "Should the rider collect the cost of the item from the customer upon delivery?", [
          { id: "pay_prepaid", title: "Customer has paid" },
          { id: "pay_cod", title: "Yes, collect cash" }
        ]);
      }
    } else if (session.step === "awaiting_package_size") {
      const text = userText.trim().toLowerCase();
      let size = "Small";
      if (text.includes("large") || text.includes("bulky") || text.includes("heavy")) {
        size = "Large";
      } else if (text.includes("medium") || text.includes("box")) {
        size = "Medium";
      }

      session.draftDelivery.size = size;
      session.step = "awaiting_payment_method";
      await sessionManager.saveSession(userPhone, session);
      await sendButtons(userPhone, "Should the rider collect the cost of the item from the customer upon delivery?", [
        { id: "pay_prepaid", title: "Customer has paid" },
        { id: "pay_cod", title: "Yes, collect cash" }
      ]);
    } else if (session.step === "awaiting_payment_method") {
      await sendButtons(userPhone, "Should the rider collect the cost of the item from the customer upon delivery?", [
        { id: "pay_prepaid", title: "Customer has paid" },
        { id: "pay_cod", title: "Yes, collect cash" }
      ]);
    } else if (session.step === "awaiting_cod_amount") {
      const parsedAmount = parseInt(userText.replace(/[^0-9]/g, ""), 10);
      if (isNaN(parsedAmount) || parsedAmount < 0) {
        await sendText(userPhone, "Invalid amount. Please enter only the numeric price of the item to be collected (e.g. 5000. Do not include the delivery fee):");
      } else {
        session.draftDelivery.cod = true;
        session.draftDelivery.codAmount = parsedAmount;
        session.step = "awaiting_confirmation";
        await sessionManager.saveSession(userPhone, session);
        await showDeliverySummary(userPhone, session.draftDelivery, session);
      }
    } else if (session.step === "awaiting_confirmation") {
      await showDeliverySummary(userPhone, session.draftDelivery, session);
    } else if (session.step === "awaiting_tracking_code") {
      const trackingCode = userText.trim().toUpperCase();
      const delivery = await db.getDeliveryByTrackingCode(trackingCode);

      if (delivery) {
        let statusEmoji = "🚚";
        if (delivery.status === "delivered") statusEmoji = "✓";
        else if (delivery.status === "cancelled") statusEmoji = "✕";
        else if (delivery.status === "searching") statusEmoji = "🔍";
        else if (delivery.status === "in_transit") statusEmoji = "🛵";

        const dropoff = delivery.dropoff || delivery.address || "Lagos, Nigeria";
        const item = delivery.item || delivery.category || "Package";
        const status = delivery.status || "searching";
        const customerPhone = delivery.customer_phone || delivery.customerPhone || "Not provided";

        const trackingLink = buildTrackingLink(delivery);

        const statusMessage = [
          `🔍 Order Status found:`,
          `• Reference: ${trackingCode}`,
          `• Item: ${item}`,
          `• Customer Phone: ${customerPhone}`,
          `• Dropoff: ${dropoff}`,
          `• Status: ${statusEmoji} ${status.toUpperCase()}`,
          `• Real-time Tracking: ${trackingLink}`
        ].join('\n');

        await sendButtons(userPhone, statusMessage, [
          { id: 'btn_main_menu', title: 'Back to Menu' }
        ]);
        await sessionManager.clearSession(userPhone);
      } else {
        await sendButtons(userPhone, `✕ Order "${trackingCode}" not found.\n\nPlease check the reference number and try again.`, [
          { id: 'btn_track', title: 'Try Again 🔍' },
          { id: 'btn_main_menu', title: 'Back to Menu' }
        ]);
        await sessionManager.clearSession(userPhone);
      }
    } else {
      // Vendor typed free text the button flow doesn't handle. Let the AI try to
      // understand it before falling back to the menu.
      await handleSmartMessage(userPhone, userText, session);
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
// WhatsApp limits reply button titles to 20 characters; longer titles cause the
// whole message to be rejected with a 400, which silently stalls the flow.
async function sendButtons(to, text, buttons) {
  const formattedButtons = buttons.map(btn => {
    let title = btn.title;
    if (title && title.length > 20) {
      console.warn(`Button title "${title}" exceeds 20 chars; truncating to avoid WhatsApp rejection.`);
      title = title.slice(0, 20);
    }
    return {
      type: "reply",
      reply: {
        id: btn.id,
        title: title
      }
    };
  });

  try {
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
  } catch (err) {
    // Surface the actual WhatsApp API error instead of failing silently
    console.error("sendButtons failed:", err.response?.data || err.message);
    throw err;
  }
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
    session.batch = [];
    await sessionManager.saveSession(phone, session);
    return;
  }

  if (input === 'btn_track') {
    await sendText(phone, "Please enter the Reference Number / Tracking Code of the order (e.g. AK123456):");
    session.step = 'awaiting_tracking_code';
    session.draftDelivery = {};
    await sessionManager.saveSession(phone, session);
    return;
  }

  if (input === 'btn_account') {
    const deliveries = await db.getDeliveriesByVendor(phone);
    const profileText = [
      `👤 My Account Details:`,
      `• Business: ${vendor.name}`,
      `• Registered Phone: ${phone}`,
      `\n📦 Recent Deliveries (Last 5):`
    ];

    if (deliveries.length === 0) {
      profileText.push("No deliveries created yet.");
    } else {
      deliveries.forEach((d, i) => {
        let statusEmoji = "🚚";
        if (d.status === "delivered") statusEmoji = "✓";
        else if (d.status === "cancelled") statusEmoji = "✕";
        else if (d.status === "searching") statusEmoji = "🔍";
        else if (d.status === "in_transit") statusEmoji = "🛵";

        const dropoff = d.dropoff || d.address || "Lagos, Nigeria";
        const code = d.tracking_code || d.trackingCode || "N/A";
        const status = d.status || "searching";

        profileText.push(`${i + 1}. ${code} · ${dropoff} · ${statusEmoji} ${status.toUpperCase()}`);
      });
    }

    const message = profileText.join('\n');
    await sendButtons(phone, message, [
      { id: 'btn_main_menu', title: 'Back to Menu' }
    ]);
    await sessionManager.clearSession(phone);
    return;
  }

  // Default: show main menu
  const greeting = vendor.name ? `Hi ${vendor.name} 👋` : `Hi!`;
  await sendButtons(phone, `${greeting}\n\nWhat do you need?`, [
    { id: 'btn_new_delivery', title: 'New delivery' },
    { id: 'btn_track', title: 'Track order' },
    { id: 'btn_account', title: 'My account' }
  ]);
}

// Look up a tracking code and send its status. Returns true if found.
async function sendTrackingStatus(phone, trackingCode) {
  const delivery = await db.getDeliveryByTrackingCode(trackingCode);
  if (!delivery) {
    await sendButtons(phone, `✕ Order "${trackingCode}" not found.\n\nPlease check the reference number and try again.`, [
      { id: 'btn_track', title: 'Try Again 🔍' },
      { id: 'btn_main_menu', title: 'Back to Menu' }
    ]);
    return false;
  }

  let statusEmoji = "🚚";
  if (delivery.status === "delivered") statusEmoji = "✓";
  else if (delivery.status === "cancelled") statusEmoji = "✕";
  else if (delivery.status === "searching") statusEmoji = "🔍";
  else if (delivery.status === "in_transit") statusEmoji = "🛵";

  const dropoff = delivery.dropoff || delivery.address || "Lagos, Nigeria";
  const item = delivery.item || delivery.category || "Package";
  const status = delivery.status || "searching";
  const customerPhone = delivery.customer_phone || delivery.customerPhone || "Not provided";
  const trackingLink = buildTrackingLink(delivery);

  const statusMessage = [
    `🔍 Order Status found:`,
    `• Reference: ${trackingCode}`,
    `• Item: ${item}`,
    `• Customer Phone: ${customerPhone}`,
    `• Dropoff: ${dropoff}`,
    `• Status: ${statusEmoji} ${status.toUpperCase()}`,
    `• Real-time Tracking: ${trackingLink}`
  ].join('\n');

  await sendButtons(phone, statusMessage, [
    { id: 'btn_main_menu', title: 'Back to Menu' }
  ]);
  return true;
}

// AI entry point: called when a vendor types free text the button flow doesn't
// handle. Understands intent and either routes into the guided flow, tracks an
// order, or answers a question — always falling back to the menu when unsure.
async function handleSmartMessage(phone, text, session) {
  const understood = await ai.understandMessage(text);

  if (understood.intent === "create_delivery") {
    // Pre-fill whatever the AI extracted, then jump into the flow at the first gap.
    // Only carry over fields that map cleanly onto the guided flow. The item is
    // left for the Food/Clothing/Others buttons since those drive the fee.
    session.draftDelivery = {};
    session.batch = [];
    if (understood.delivery.address) session.draftDelivery.address = understood.delivery.address;
    if (understood.delivery.customerPhone) session.draftDelivery.customerPhone = understood.delivery.customerPhone;
    await advanceDeliveryFlow(phone, session);
    return;
  }

  if (understood.intent === "track_order") {
    if (understood.trackingCode) {
      await sendTrackingStatus(phone, understood.trackingCode);
      await sessionManager.clearSession(phone);
    } else {
      await sendText(phone, "Please enter the Reference Number / Tracking Code of the order (e.g. AK123456):");
      session.step = "awaiting_tracking_code";
      session.draftDelivery = {};
      await sessionManager.saveSession(phone, session);
    }
    return;
  }

  if ((understood.intent === "question" || understood.intent === "greeting") && understood.answer) {
    await sendButtons(phone, understood.answer, [
      { id: 'btn_new_delivery', title: 'New delivery' },
      { id: 'btn_track', title: 'Track order' },
      { id: 'btn_account', title: 'My account' }
    ]);
    return;
  }

  // Unknown / no usable answer: fall back to the menu.
  await handleMenu(phone, null, session);
}

// Given a draftDelivery pre-filled from free text, ask for the address if we
// don't have one, otherwise confirm the extracted address. From confirmation the
// existing button flow takes over (and skips the phone step if one was captured).
async function advanceDeliveryFlow(phone, session) {
  const d = session.draftDelivery || {};

  if (!d.address) {
    session.step = "awaiting_address_input";
    await sessionManager.saveSession(phone, session);
    await sendText(phone, "Please enter your customer's delivery address:");
    return;
  }

  session.step = "confirm_address_input";
  await sessionManager.saveSession(phone, session);
  await sendButtons(phone, `Got it. Address:\n${d.address}\n\nIs this correct?`, [
    { id: "confirm_address", title: "Confirm Address" },
    { id: "edit_address", title: "Edit Address" }
  ]);
}

// User-provided logic: Show delivery summary
async function showDeliverySummary(phone, d, session) {
  const fee = await calculateZoneFee(d.pickupLat, d.pickupLng, d.lat, d.lng, d.size);
  const paymentText = d.cod
    ? `Cash on Delivery (₦${d.codAmount.toLocaleString()} to collect)`
    : 'Already Paid (Prepaid)';

  const itemLine = d.size
    ? `• Item: ${d.category} (Size: ${d.size})`
    : `• Item: ${d.category}`;

  // If the vendor has already queued stops, this is an additional one in the batch
  const batch = session && Array.isArray(session.batch) ? session.batch : [];
  const batchCount = batch.length;
  const header = batchCount > 0
    ? `📦 Delivery summary (delivery ${batchCount + 1}):\n`
    : '📦 Delivery summary:\n';

  const summaryLines = [
    header,
    `• Drop: ${d.address}`,
    `• Customer Phone: ${d.customerPhone || 'Not provided'}`,
    itemLine,
    `• Payment: ${paymentText}`,
    `• Delivery fee: ₦${fee.toLocaleString()}`
  ];

  // For a batch, add the combined delivery cost across every queued stop plus this one.
  if (batchCount > 0) {
    const queuedFees = await Promise.all(
      batch.map(stop => calculateZoneFee(stop.pickupLat, stop.pickupLng, stop.lat, stop.lng, stop.size))
    );
    const totalFee = queuedFees.reduce((sum, f) => sum + f, 0) + fee;
    summaryLines.push(`\n• Total delivery cost (${batchCount + 1} deliveries): ₦${totalFee.toLocaleString()}`);
  }

  summaryLines.push('\nConfirm?');
  const summary = summaryLines.join('\n');

  await sendButtons(phone, summary, [
    { id: 'confirm_yes', title: batchCount > 0 ? 'Confirm all ✓' : 'Confirm ✓' },
    { id: 'add_stop', title: 'Add delivery ➕' },
    { id: 'confirm_no', title: 'Cancel' }
  ]);
}

// Process status updates from the Rider App (delivered/failed) and alert vendor
async function handleRiderStatusUpdate(trackingCode, status, reason = "") {
  const code = trackingCode.trim().toUpperCase();
  const delivery = await db.getDeliveryByTrackingCode(code);
  if (!delivery) return null;

  const updatedDelivery = await db.updateDeliveryStatus(code, status);
  const vendorPhone = delivery.vendor_phone || delivery.vendorPhone;
  const batchId = delivery.batch_id || delivery.batchId;

  let batchDeliveries = [];
  if (batchId) {
    batchDeliveries = await db.getDeliveriesByBatchId(batchId);
  }
  if (!batchDeliveries || batchDeliveries.length === 0) {
    batchDeliveries = [updatedDelivery];
  }

  const totalCount = batchDeliveries.length;
  const completedDeliveries = batchDeliveries.filter(
    d => d.status === "delivered" || d.status === "failed"
  );
  const completedCount = completedDeliveries.length;
  const index = batchDeliveries.findIndex(d => (d.tracking_code || d.trackingCode) === code) + 1;
  const itemDesc = delivery.item || delivery.category || "Package";
  const dropoff = delivery.dropoff || delivery.address || "Dropoff location";

  if (vendorPhone) {
    const isSuccess = status === "delivered";
    const statusEmoji = isSuccess ? "✅" : "❌";
    const resultText = isSuccess ? "Successful" : `Failed (${reason || "Customer unreachable"})`;

    const lines = [
      `${statusEmoji} Delivery Update: ${isSuccess ? "Delivered Successfully!" : "Delivery Failed"}`,
      `• Reference: ${code}`,
      `• Item: ${itemDesc}`,
      `• Dropoff: ${dropoff}`,
      `• Outcome: ${resultText}`
    ];

    if (totalCount > 1) {
      lines.push(`\nProgress: Delivery ${index > 0 ? index : completedCount} of ${totalCount} completed (${completedCount}/${totalCount} finished)`);
    }

    await sendText(vendorPhone, lines.join("\n"));

    // When the LAST delivery in the batch is marked complete by the rider:
    if (completedCount === totalCount) {
      const ratingMsg = totalCount > 1
        ? `🎉 All ${totalCount} deliveries in this order are now complete!\n\nPlease rate the rider's service to mark this order finalized:`
        : `🎉 Delivery complete!\n\nPlease rate the rider's service to mark this order finalized:`;

      const safeBatchRef = batchId || code;
      await sendButtons(vendorPhone, ratingMsg, [
        { id: `rate_5_${safeBatchRef}`, title: "⭐⭐⭐⭐⭐ 5 Stars" },
        { id: `rate_4_${safeBatchRef}`, title: "⭐⭐⭐⭐ 4 Stars" },
        { id: `rate_3_${safeBatchRef}`, title: "⭐⭐⭐ 3 Stars" }
      ]);
    }
  }

  return updatedDelivery;
}

// User-provided logic: Handle confirmation of summary
async function handleConfirmSummary(phone, buttonId, session) {
  if (buttonId === 'confirm_no') {
    await sessionManager.clearSession(phone);
    await sendText(phone, 'Cancelled. Send "hi" to start again.');
    return;
  }

  // Use the vendor's registered business location as the pickup point for the rider
  const vendor = await db.getVendor(phone);
  const pickup = vendor && vendor.location ? vendor.location : "";

  // Commit every queued stop plus the one currently on screen. Single-delivery
  // flows have an empty batch, so this is just an array of one.
  const stops = [...(Array.isArray(session.batch) ? session.batch : []), session.draftDelivery];
  const created = [];
  const batchId = "BATCH-" + Math.floor(100000 + Math.random() * 900000);

  for (const stop of stops) {
    const trackingCode = generateTrackingCode();
    const delivery = await db.createDelivery({
      vendorPhone: phone,
      ...stop,
      pickup: pickup,
      status: 'searching',
      trackingCode: trackingCode,
      batchId: batchId
    });
    created.push({ delivery, trackingCode, address: stop.address || "Lagos, Nigeria" });
  }

  // Confirmation: one line per delivery for a batch, the original single-line block otherwise.
  let message;
  if (created.length > 1) {
    const lines = [`🎉 ${created.length} deliveries created successfully!`, `• Pickup: ${pickup || 'Your business location'}`, ''];
    created.forEach((c, i) => {
      const trackingLink = buildTrackingLink(c.delivery);
      lines.push(`Delivery ${i + 1}: ${c.address}`);
      lines.push(`• Reference Number: ${c.trackingCode}`);
      lines.push(`• Tracking: ${trackingLink}`);
      lines.push('');
    });
    lines.push('Status: Searching for nearby riders... 🚚');
    message = lines.join('\n');
  } else {
    const c = created[0];
    const trackingLink = buildTrackingLink(c.delivery);
    message = [
      `🎉 Delivery created successfully!`,
      `• Reference Number: ${c.trackingCode}`,
      `• Status: Searching for nearby riders... 🚚`,
      `• Real-time Tracking: ${trackingLink}`
    ].join('\n');
  }

  await sendText(phone, message);

  // Simulate rider assignment after 5 seconds — one rider picks up the whole batch at once
  setTimeout(async () => {
    try {
      const riders = ["Chinedu", "Tunde", "Abubakar", "Emeka"];
      const riderName = riders[Math.floor(Math.random() * riders.length)];
      const riderPhone = "080" + Math.floor(10000000 + Math.random() * 90000000);
      const etaMinutes = Math.floor(3 + Math.random() * 10);
      const rating = (4.5 + Math.random() * 0.5).toFixed(1);
      const trips = Math.floor(50 + Math.random() * 200);

      // Stand-in for the real rider app posting to POST /rider/location: seed each
      // delivery with a starting GPS point near Lagos so the tracking link goes
      // live. Replace this once a real rider device reports its coordinates.
      for (const c of created) {
        const riderLat = 6.5244 + (Math.random() - 0.5) * 0.05;
        const riderLng = 3.3792 + (Math.random() - 0.5) * 0.05;
        await db.updateRiderLocation(c.trackingCode, riderLat, riderLng);
      }

      const riderLines = [
        `🏍️ Rider assigned!`,
        `• Name: ${riderName}`,
        `• Rating: ⭐ ${rating} (${trips} successful deliveries)`,
        `• Phone: ${riderPhone}`,
        `• ETA to Pickup: ${etaMinutes} minutes 🕒`,
        `• Status: Heading to your location`
      ];

      if (created.length > 1) {
        riderLines.push(`\nOne rider is handling all ${created.length} deliveries:`);
        created.forEach((c, i) => {
          riderLines.push(`  ${i + 1}. ${c.trackingCode} · ${c.address}`);
        });
      }

      // Cancel action covers every delivery in the batch (comma-separated ids)
      const cancelId = created.map(c => c.delivery.id).join(",");
      const cancelTitle = created.length > 1 ? "Cancel All ✕" : "Cancel Delivery ✕";

      await sendButtons(phone, riderLines.join('\n'), [
        { id: `cancel_del_${cancelId}`, title: cancelTitle }
      ]);
    } catch (err) {
      console.error("Rider simulation error:", err);
    }
  }, 5000);

  // Simulate the rider reaching pickup and collecting the package. Once picked up
  // and heading to the drop-off, the order can no longer be cancelled — so we move
  // it to 'in_transit' and send a follow-up with no cancel button.
  setTimeout(async () => {
    try {
      const pickedUp = [];
      for (const c of created) {
        const updated = await db.markPickedUp(c.delivery.id);
        // Only announce deliveries that were still active (skips any the vendor cancelled in time)
        if (updated) pickedUp.push(c);
      }
      if (pickedUp.length === 0) return;

      const lines = [
        pickedUp.length > 1
          ? `📦 Your ${pickedUp.length} deliveries have been picked up!`
          : `📦 Your delivery has been picked up!`,
        `• Status: Rider is on the way to the drop-off 🛵`,
        `• This order can no longer be cancelled.`
      ];
      if (pickedUp.length > 1) {
        pickedUp.forEach((c, i) => {
          lines.push(`  ${i + 1}. ${c.trackingCode} · ${c.address}`);
        });
      }
      await sendText(phone, lines.join('\n'));

      // Simulate rider completing drop-offs sequentially one by one
      pickedUp.forEach((c, idx) => {
        setTimeout(async () => {
          try {
            await handleRiderStatusUpdate(c.trackingCode, "delivered");
          } catch (err) {
            console.error("Simulated delivery completion error:", err);
          }
        }, (idx + 1) * 15000);
      });
    } catch (err) {
      console.error("Pickup simulation error:", err);
    }
  }, 20000);

  await sessionManager.clearSession(phone);
}

// Helper: Calculate zone fee based on distance and package size
async function calculateZoneFee(pickupLat, pickupLng, lat, lng, size) {
  let baseFee = 1500;
  if (size === "Medium") {
    baseFee = 2500;
  } else if (size === "Large") {
    baseFee = 4000;
  }
  return baseFee;
}

// Helper: Generate tracking code
function generateTrackingCode() {
  return "AK" + Math.floor(100000 + Math.random() * 900000);
}

// Build the Google Maps tracking link for a delivery. If the rider has reported a
// live GPS position, point at it (opens the rider's spot in Maps); otherwise fall
// back to directions to the drop-off address so tracking always works.
function buildTrackingLink(delivery) {
  const lat = delivery && (delivery.rider_lat ?? delivery.riderLat);
  const lng = delivery && (delivery.rider_lng ?? delivery.riderLng);
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }
  const dropoff = (delivery && (delivery.dropoff || delivery.address)) || "Lagos, Nigeria";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dropoff)}`;
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

// Delivery parsing and question answering now live in ai.js (understandMessage).

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Aika bot running on port", PORT);
});