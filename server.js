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
          session.step = "awaiting_customer_phone";
          await sessionManager.saveSession(userPhone, session);
          await sendText(userPhone, "Please enter the customer's phone number for the rider to call (e.g. 08012345678):");
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

        const trackingLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dropoff)}`;

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
  const batchCount = session && Array.isArray(session.batch) ? session.batch.length : 0;
  const header = batchCount > 0
    ? `📦 Delivery summary (delivery ${batchCount + 1}):\n`
    : '📦 Delivery summary:\n';

  const summary = [
    header,
    `• Drop: ${d.address}`,
    `• Customer Phone: ${d.customerPhone || 'Not provided'}`,
    itemLine,
    `• Payment: ${paymentText}`,
    `• Delivery fee: ₦${fee}`,
    '\nConfirm?'
  ].join('\n');

  await sendButtons(phone, summary, [
    { id: 'confirm_yes', title: batchCount > 0 ? 'Confirm all ✓' : 'Confirm ✓' },
    { id: 'add_stop', title: 'Add another delivery ➕' },
    { id: 'confirm_no', title: 'Cancel' }
  ]);
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

  for (const stop of stops) {
    const trackingCode = generateTrackingCode();
    const delivery = await db.createDelivery({
      vendorPhone: phone,
      ...stop,
      pickup: pickup,
      status: 'searching',
      trackingCode: trackingCode
    });
    created.push({ delivery, trackingCode, address: stop.address || "Lagos, Nigeria" });
  }

  // Confirmation: one line per delivery for a batch, the original single-line block otherwise.
  let message;
  if (created.length > 1) {
    const lines = [`🎉 ${created.length} deliveries created successfully!`, `• Pickup: ${pickup || 'Your business location'}`, ''];
    created.forEach((c, i) => {
      const trackingLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(c.address)}`;
      lines.push(`Delivery ${i + 1}: ${c.address}`);
      lines.push(`• Reference Number: ${c.trackingCode}`);
      lines.push(`• Tracking: ${trackingLink}`);
      lines.push('');
    });
    lines.push('Status: Searching for nearby riders... 🚚');
    message = lines.join('\n');
  } else {
    const c = created[0];
    const trackingLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(c.address)}`;
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