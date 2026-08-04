// Load .env variables before reading process.env (supports both `node server.js` and `node --env-file=.env server.js`)
try { require(require('path').join(__dirname, 'node_modules', 'dotenv')).config({ path: require('path').join(__dirname, '.env') }); } catch (e) { /* dotenv optional */ }

const mongoose = require("mongoose");

// Mongoose Schemas
const vendorSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  name: { type: String },
  location: { type: String, default: null },
  created_at: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  session_data: { type: mongoose.Schema.Types.Mixed, default: { step: 'menu', draftDelivery: {} } },
  updated_at: { type: Date, default: Date.now }
});

const deliverySchema = new mongoose.Schema({
  id: { type: Number },
  vendor_phone: { type: String, index: true },
  pickup: { type: String, default: "" },
  dropoff: { type: String, default: "" },
  item: { type: String, default: "" },
  status: { type: String, default: "searching" },
  tracking_code: { type: String, index: true },
  customer_phone: { type: String, default: "" },
  batch_id: { type: String, index: true, default: null },
  rating: { type: Number, default: null },
  rider_name: { type: String, default: "" },
  rider_phone: { type: String, default: "" },
  rider_lat: { type: Number, default: null },
  rider_lng: { type: Number, default: null },
  rider_updated_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now }
});

const jobSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true },
  trackingCode: { type: String, default: "" },
  vendorPhone: { type: String, default: "" },
  vendor: {
    name: { type: String, default: "WhatsApp Vendor" },
    address: { type: String, default: "Kaduna" },
    itemsDescription: { type: String, default: "Package" },
  },
  customer: {
    name: { type: String, default: "Customer" },
    address: { type: String, default: "Kaduna" },
    phone: { type: String, default: "" },
  },
  category: { type: String, default: "General" },
  deliveryFee: { type: Number, default: 1500 },
  codAmount: { type: Number, default: 0 },
  amountFormatted: { type: String, default: "₦1,500" },
  status: { type: String, default: "available" },
  riderId: { type: mongoose.Schema.Types.ObjectId, ref: "Rider", default: null },
  riderName: { type: String, default: "" },
  riderPhone: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Vendor = mongoose.models.Vendor || mongoose.model("Vendor", vendorSchema);
const Session = mongoose.models.Session || mongoose.model("Session", sessionSchema);
const Delivery = mongoose.models.Delivery || mongoose.model("Delivery", deliverySchema);
const Job = mongoose.models.Job || mongoose.model("Job", jobSchema);

let isConnected = false;

const memoryDb = {
  vendors: {},
  deliveries: [],
  sessions: {}
};

const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL;

if (mongoUri && mongoUri.startsWith("mongodb")) {
  mongoose
    .connect(mongoUri)
    .then(() => {
      isConnected = true;
      console.log("Connected to MongoDB successfully via Mongoose.");
    })
    .catch((err) => {
      console.error("MongoDB connection error, falling back to in-memory DB:", err.message);
      isConnected = false;
    });
} else {
  console.log("No valid MONGO_URI found. Running with in-memory database.");
}

const axios = require("axios");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

async function getVendor(phone) {
  if (!phone) return null;
  const cleanDigits = phone.replace(/\D/g, "");
  const last10 = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;

  if (memoryDb.vendors[phone]) {
    return memoryDb.vendors[phone];
  }
  for (const p in memoryDb.vendors) {
    if (p.replace(/\D/g, "").slice(-10) === last10) {
      return memoryDb.vendors[p];
    }
  }

  if (isConnected) {
    try {
      let vendor = await Vendor.findOne({ phone }).lean();
      if (!vendor && last10) {
        vendor = await Vendor.findOne({ phone: { $regex: last10 + "$", $options: "i" } }).lean();
      }
      if (vendor) return vendor;
    } catch (err) {
      console.error("MongoDB getVendor error, falling back to memory:", err.message);
    }
  }

  // Fallback: check aika-Backend MongoDB API
  try {
    const res = await axios.get(`${BACKEND_URL}/api/vendors/by-phone/${encodeURIComponent(phone)}`);
    if (res.data && res.data.vendor) {
      const v = res.data.vendor;
      const vendorObj = {
        phone: v.phone || phone,
        name: v.name,
        location: v.location || "Kaduna",
        category: v.category || "Food & Drinks",
        email: v.email || "",
      };
      memoryDb.vendors[phone] = vendorObj;
      return vendorObj;
    }
  } catch (err) {
    // Vendor not found in backend DB
  }

  return null;
}

async function createVendor(phone, name, location = null, extraDetails = {}) {
  const vendorObj = {
    phone,
    name,
    location: location || "Kaduna",
    ownerName: extraDetails.ownerName || "",
    category: extraDetails.category || "Food & Drinks",
    email: extraDetails.email || "",
    status: "Active",
  };

  // Sync vendor to aika-Backend MongoDB API
  try {
    await axios.post(`${BACKEND_URL}/api/vendors`, vendorObj);
    console.log(`Synced vendor "${name}" (${phone}) to aika-Backend MongoDB`);
  } catch (err) {
    console.error("Failed to sync vendor to aika-Backend:", err.message);
  }

  if (isConnected) {
    try {
      const doc = await Vendor.findOneAndUpdate(
        { phone },
        { $set: { name, location: location || "Kaduna" } },
        { upsert: true, returnDocument: "after" }
      ).lean();
      return { ...doc, ...vendorObj };
    } catch (err) {
      console.error("DB createVendor error, falling back to memory:", err.message);
    }
  }
  memoryDb.vendors[phone] = vendorObj;
  return memoryDb.vendors[phone];
}




async function createDelivery(delivery) {
  const trackingCode = delivery.trackingCode || ("AK" + Math.floor(100000 + Math.random() * 900000));
  const fee = Number(delivery.deliveryFee) || 1500;
  const cod = Number(delivery.codAmount) || 0;

  if (isConnected) {
    try {
      const count = await Delivery.countDocuments();
      const nextId = count + 1;
      const vendorObj = await getVendor(delivery.vendorPhone);

      // 1. Create Delivery in bot DB
      const newDoc = await Delivery.create({
        id: nextId,
        vendor_phone: delivery.vendorPhone,
        pickup: delivery.pickup || (vendorObj ? vendorObj.location : ""),
        dropoff: delivery.dropoff || delivery.address || "",
        item: delivery.item || delivery.category || "",
        status: delivery.status || "available",
        tracking_code: trackingCode,
        customer_phone: delivery.customerPhone || "",
        batch_id: delivery.batchId || null
      });

      // 2. Direct Sync into Job collection (read by Web Dashboard & Rider App)
      try {
        await Job.create({
          orderNumber: trackingCode,
          trackingCode: trackingCode,
          vendorPhone: delivery.vendorPhone || "",
          vendor: {
            name: vendorObj ? vendorObj.name : "WhatsApp Vendor",
            address: delivery.pickup || (vendorObj ? vendorObj.location : "Kaduna"),
            itemsDescription: delivery.item || delivery.category || "Package",
          },
          customer: {
            name: "Customer",
            address: delivery.dropoff || delivery.address || "Kaduna",
            phone: delivery.customerPhone || delivery.vendorPhone || "",
          },
          category: delivery.category || "General",
          deliveryFee: fee,
          codAmount: cod,
          amountFormatted: `₦${(cod + fee).toLocaleString()}`,
          status: "available",
        });
        console.log(`Directly created Job document "${trackingCode}" in MongoDB`);
      } catch (jobErr) {
        console.error("Direct Job creation error in bot:", jobErr.message);
      }

      return newDoc.toObject();
    } catch (err) {
      console.error("MongoDB createDelivery error, falling back to memory:", err.message);
    }
  }

  const newDelivery = {
    id: memoryDb.deliveries.length + 1,
    vendor_phone: delivery.vendorPhone,
    pickup: delivery.pickup || "",
    dropoff: delivery.dropoff || delivery.address || "",
    item: delivery.item || delivery.category || "",
    status: delivery.status || "available",
    tracking_code: trackingCode,
    customer_phone: delivery.customerPhone || "",
    batch_id: delivery.batchId || null,
    rating: null,
    rider_lat: null,
    rider_lng: null,
    rider_updated_at: null
  };
  memoryDb.deliveries.push(newDelivery);
  return newDelivery;
}

async function getDeliveriesByBatchId(batchId) {
  if (!batchId) return [];
  if (isConnected) {
    try {
      return await Delivery.find({ batch_id: batchId }).lean();
    } catch (err) {
      console.error("MongoDB getDeliveriesByBatchId error, falling back to memory:", err.message);
    }
  }
  return memoryDb.deliveries.filter(d => d.batch_id === batchId);
}

async function updateBatchRating(batchId, rating) {
  if (!batchId) return;
  if (isConnected) {
    try {
      await Delivery.updateMany({ batch_id: batchId }, { $set: { rating: Number(rating) } });
      return;
    } catch (err) {
      console.error("MongoDB updateBatchRating error, falling back to memory:", err.message);
    }
  }
  memoryDb.deliveries.forEach(d => {
    if (d.batch_id === batchId) d.rating = Number(rating);
  });
}

async function getSession(phone) {
  if (isConnected) {
    try {
      const session = await Session.findOne({ phone }).lean();
      if (session && session.session_data) {
        return session.session_data;
      }
    } catch (err) {
      console.error("MongoDB getSession error, falling back to memory:", err.message);
    }
  }
  return memoryDb.sessions[phone] || { step: 'menu', draftDelivery: {} };
}

async function saveSession(phone, sessionData) {
  if (isConnected) {
    try {
      await Session.findOneAndUpdate(
        { phone },
        { $set: { session_data: sessionData, updated_at: new Date() } },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
      );
      memoryDb.sessions[phone] = sessionData;
      return;
    } catch (err) {
      console.error("MongoDB saveSession error, falling back to memory:", err.message);
    }
  }
  memoryDb.sessions[phone] = sessionData;
}

async function updateDeliveryStatus(deliveryId, status, extraFields = {}) {
  const updateObj = { status };
  if (extraFields.riderName || extraFields.rider_name) updateObj.rider_name = extraFields.riderName || extraFields.rider_name;
  if (extraFields.riderPhone || extraFields.rider_phone) updateObj.rider_phone = extraFields.riderPhone || extraFields.rider_phone;

  if (isConnected) {
    try {
      const numericId = parseInt(deliveryId, 10);
      const query = !isNaN(numericId)
        ? { $or: [{ id: numericId }, { tracking_code: deliveryId }] }
        : { tracking_code: deliveryId };

      const updated = await Delivery.findOneAndUpdate(
        query,
        { $set: updateObj },
        { returnDocument: 'after' }
      ).lean();

      // Keep Job document in sync for Web Dashboard and Rider App
      try {
        const jobUpdate = { status };
        if (extraFields.riderName || extraFields.rider_name) jobUpdate.riderName = extraFields.riderName || extraFields.rider_name;
        if (extraFields.riderPhone || extraFields.rider_phone) jobUpdate.riderPhone = extraFields.riderPhone || extraFields.rider_phone;
        await Job.findOneAndUpdate(
          { $or: [{ orderNumber: deliveryId }, { trackingCode: deliveryId }] },
          { $set: jobUpdate }
        );
      } catch (e) { /* ignore */ }

      if (updated) {
        if (!updated.riderName && updated.rider_name) updated.riderName = updated.rider_name;
        if (!updated.riderPhone && updated.rider_phone) updated.riderPhone = updated.rider_phone;
        return updated;
      }
    } catch (err) {
      console.error("MongoDB updateDeliveryStatus error, falling back to memory:", err.message);
    }
  }

  const numericId = parseInt(deliveryId, 10);
  const delivery = memoryDb.deliveries.find(
    d => (!isNaN(numericId) && d.id === numericId) || d.tracking_code === deliveryId
  );
  if (delivery) {
    delivery.status = status;
    if (updateObj.rider_name) {
      delivery.rider_name = updateObj.rider_name;
      delivery.riderName = updateObj.rider_name;
    }
    if (updateObj.rider_phone) {
      delivery.rider_phone = updateObj.rider_phone;
      delivery.riderPhone = updateObj.rider_phone;
    }
    return delivery;
  }
  return null;
}

async function cancelDelivery(deliveryId) {
  if (isConnected) {
    try {
      const numericId = parseInt(deliveryId, 10);
      const query = !isNaN(numericId)
        ? { $or: [{ id: numericId }, { tracking_code: deliveryId }], status: "searching" }
        : { tracking_code: deliveryId, status: "searching" };

      const cancelled = await Delivery.findOneAndUpdate(
        query,
        { $set: { status: "cancelled" } },
        { returnDocument: 'after' }
      ).lean();

      if (cancelled) return { result: 'cancelled', delivery: cancelled };

      // Determine if delivery exists but wasn't cancellable
      const existingQuery = !isNaN(numericId)
        ? { $or: [{ id: numericId }, { tracking_code: deliveryId }] }
        : { tracking_code: deliveryId };
      const existing = await Delivery.findOne(existingQuery).lean();

      if (existing) return { result: 'not_cancellable', delivery: existing };
      return { result: 'not_found', delivery: null };
    } catch (err) {
      console.error("MongoDB cancelDelivery error, falling back to memory:", err.message);
    }
  }

  const numericId = parseInt(deliveryId, 10);
  const delivery = memoryDb.deliveries.find(
    d => (!isNaN(numericId) && d.id === numericId) || d.tracking_code === deliveryId
  );
  if (!delivery) return { result: 'not_found', delivery: null };
  if (delivery.status !== 'searching') return { result: 'not_cancellable', delivery };
  delivery.status = 'cancelled';
  return { result: 'cancelled', delivery };
}

async function markPickedUp(deliveryId) {
  if (isConnected) {
    try {
      const numericId = parseInt(deliveryId, 10);
      const query = !isNaN(numericId)
        ? { $or: [{ id: numericId }, { tracking_code: deliveryId }], status: "searching" }
        : { tracking_code: deliveryId, status: "searching" };

      const updated = await Delivery.findOneAndUpdate(
        query,
        { $set: { status: "in_transit" } },
        { returnDocument: 'after' }
      ).lean();
      return updated || null;
    } catch (err) {
      console.error("MongoDB markPickedUp error, falling back to memory:", err.message);
    }
  }

  const numericId = parseInt(deliveryId, 10);
  const delivery = memoryDb.deliveries.find(
    d => (!isNaN(numericId) && d.id === numericId) || d.tracking_code === deliveryId
  );
  if (delivery && delivery.status === 'searching') {
    delivery.status = 'in_transit';
    return delivery;
  }
  return null;
}

async function updateRiderLocation(trackingCode, lat, lng) {
  if (isConnected) {
    try {
      const updated = await Delivery.findOneAndUpdate(
        { tracking_code: trackingCode },
        { $set: { rider_lat: lat, rider_lng: lng, rider_updated_at: new Date() } },
        { returnDocument: 'after' }
      ).lean();
      return updated || null;
    } catch (err) {
      console.error("MongoDB updateRiderLocation error, falling back to memory:", err.message);
    }
  }

  const delivery = memoryDb.deliveries.find(d => d.tracking_code === trackingCode);
  if (delivery) {
    delivery.rider_lat = lat;
    delivery.rider_lng = lng;
    delivery.rider_updated_at = new Date().toISOString();
    return delivery;
  }
  return null;
}

async function getDeliveryByTrackingCode(trackingCode) {
  let delivery = null;
  if (isConnected) {
    try {
      delivery = await Delivery.findOne({ tracking_code: trackingCode }).lean();
    } catch (err) {
      console.error("MongoDB getDeliveryByTrackingCode error, falling back to memory:", err.message);
    }
  }
  if (!delivery) {
    delivery = memoryDb.deliveries.find(d => d.tracking_code === trackingCode) || null;
  }
  if (delivery) {
    if (!delivery.riderName && delivery.rider_name) delivery.riderName = delivery.rider_name;
    if (!delivery.riderPhone && delivery.rider_phone) delivery.riderPhone = delivery.rider_phone;
  }
  return delivery;
}

async function getDeliveriesByVendor(vendorPhone) {
  if (isConnected) {
    try {
      const deliveries = await Delivery.find({ vendor_phone: vendorPhone })
        .sort({ created_at: -1 })
        .limit(5)
        .lean();
      return deliveries;
    } catch (err) {
      console.error("MongoDB getDeliveriesByVendor error, falling back to memory:", err.message);
    }
  }
  return memoryDb.deliveries
    .filter(d => d.vendor_phone === vendorPhone)
    .slice(-5)
    .reverse();
}

async function clearSession(phone) {
  const defaultSession = { step: 'menu', draftDelivery: {} };
  await saveSession(phone, defaultSession);
}

module.exports = {
  getVendor,
  createVendor,
  createDelivery,
  getDeliveriesByBatchId,
  updateBatchRating,
  updateDeliveryStatus,
  cancelDelivery,
  markPickedUp,
  updateRiderLocation,
  getDeliveryByTrackingCode,
  getDeliveriesByVendor,
  getSession,
  saveSession,
  clearSession
};
