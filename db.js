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
  rider_lat: { type: Number, default: null },
  rider_lng: { type: Number, default: null },
  rider_updated_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now }
});

const Vendor = mongoose.model("Vendor", vendorSchema);
const Session = mongoose.model("Session", sessionSchema);
const Delivery = mongoose.model("Delivery", deliverySchema);

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

async function getVendor(phone) {
  if (isConnected) {
    try {
      const vendor = await Vendor.findOne({ phone }).lean();
      return vendor || null;
    } catch (err) {
      console.error("MongoDB getVendor error, falling back to memory:", err.message);
    }
  }
  return memoryDb.vendors[phone] || null;
}

async function createVendor(phone, name, location = null) {
  if (isConnected) {
    try {
      const updated = await Vendor.findOneAndUpdate(
        { phone },
        { $set: { name, ...(location ? { location } : {}) } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();
      return updated;
    } catch (err) {
      console.error("MongoDB createVendor error, falling back to memory:", err.message);
    }
  }
  const existing = memoryDb.vendors[phone] || {};
  memoryDb.vendors[phone] = { phone, name, location: location || existing.location || null };
  return memoryDb.vendors[phone];
}

async function createDelivery(delivery) {
  if (isConnected) {
    try {
      const count = await Delivery.countDocuments();
      const nextId = count + 1;
      const newDoc = await Delivery.create({
        id: nextId,
        vendor_phone: delivery.vendorPhone,
        pickup: delivery.pickup || "",
        dropoff: delivery.dropoff || delivery.address || "",
        item: delivery.item || delivery.category || "",
        status: delivery.status || "searching",
        tracking_code: delivery.trackingCode || "",
        customer_phone: delivery.customerPhone || "",
        batch_id: delivery.batchId || null
      });
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
    status: delivery.status || "searching",
    tracking_code: delivery.trackingCode || "",
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
        { upsert: true, setDefaultsOnInsert: true }
      );
      memoryDb.sessions[phone] = sessionData;
      return;
    } catch (err) {
      console.error("MongoDB saveSession error, falling back to memory:", err.message);
    }
  }
  memoryDb.sessions[phone] = sessionData;
}

async function updateDeliveryStatus(deliveryId, status) {
  if (isConnected) {
    try {
      const numericId = parseInt(deliveryId, 10);
      const query = !isNaN(numericId)
        ? { $or: [{ id: numericId }, { tracking_code: deliveryId }] }
        : { tracking_code: deliveryId };

      const updated = await Delivery.findOneAndUpdate(
        query,
        { $set: { status } },
        { new: true }
      ).lean();
      if (updated) return updated;
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
        { new: true }
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
        { new: true }
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
        { new: true }
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
  if (isConnected) {
    try {
      const delivery = await Delivery.findOne({ tracking_code: trackingCode }).lean();
      return delivery || null;
    } catch (err) {
      console.error("MongoDB getDeliveryByTrackingCode error, falling back to memory:", err.message);
    }
  }
  return memoryDb.deliveries.find(d => d.tracking_code === trackingCode) || null;
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
