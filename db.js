const mongoose = require("mongoose");

const memoryDb = {
  vendors: {},
  deliveries: [],
  sessions: {}
};

const VendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    location: { type: String, default: "Kaduna North" },
    category: { type: String, default: "Food & Drinks" },
    orders: { type: Number, default: 0 },
    orderValue: { type: String, default: "₦0" },
    status: { type: String, default: "Active" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    rating: { type: Number, default: 4.8 },
  },
  { timestamps: true }
);

const JobSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    trackingCode: { type: String, default: "" },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: "Rider", default: null },
    riderName: { type: String, default: "" },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    vendorPhone: { type: String, default: "" },
    vendor: {
      name: { type: String, default: "WhatsApp Vendor" },
      address: { type: String, default: "Kaduna" },
      itemsDescription: { type: String, default: "Package" },
      fragile: { type: Boolean, default: false },
    },
    customer: {
      name: { type: String, default: "WhatsApp Customer" },
      address: { type: String, default: "Kaduna" },
      phone: { type: String, default: "" },
    },
    deliveryFee: { type: Number, default: 1500 },
    codAmount: { type: Number, default: 0 },
    amountFormatted: { type: String, default: "₦1,500" },
    category: { type: String, default: "General Delivery" },
    packageSize: { type: String, default: "Small" },
    status: {
      type: String,
      default: "available",
    },
    riderLat: { type: Number, default: null },
    riderLng: { type: Number, default: null },
    riderUpdatedAt: { type: Date, default: null },
    proofPhotoUrl: { type: String, default: "" },
    issueReason: { type: String, default: "" },
    acceptedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

const SessionSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    session_data: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

const Vendor = mongoose.models.Vendor || mongoose.model("Vendor", VendorSchema);
const Job = mongoose.models.Job || mongoose.model("Job", JobSchema);
const Session = mongoose.models.Session || mongoose.model("Session", SessionSchema);

let isConnected = false;

const connectDB = async () => {
  const uri = process.env.MONGO_URI || "mongodb+srv://aika_rider_app:aika_rider_app@cluster0.vlfuyie.mongodb.net/?appName=Cluster0";
  try {
    if (mongoose.connection.readyState >= 1) {
      isConnected = true;
      return;
    }
    await mongoose.connect(uri);
    isConnected = true;
    console.log("✅ aika-bot connected to MongoDB Atlas successfully");
  } catch (err) {
    console.error("⚠️ aika-bot MongoDB connection error, falling back to memory:", err.message);
    isConnected = false;
  }
};
connectDB();

async function getVendor(phone) {
  if (isConnected) {
    try {
      const vendor = await Vendor.findOne({ phone });
      if (vendor) {
        return {
          phone: vendor.phone,
          name: vendor.name,
          location: vendor.location,
          id: vendor._id,
        };
      }
      return null;
    } catch (err) {
      console.error("DB getVendor error:", err.message);
    }
  }
  return memoryDb.vendors[phone] || null;
}

async function createVendor(phone, name, location = null) {
  const loc = location || "Kaduna North";
  if (isConnected) {
    try {
      const vendor = await Vendor.findOneAndUpdate(
        { phone },
        { name, location: loc, status: "Active" },
        { upsert: true, new: true }
      );
      return {
        phone: vendor.phone,
        name: vendor.name,
        location: vendor.location,
        id: vendor._id,
      };
    } catch (err) {
      console.error("DB createVendor error:", err.message);
    }
  }
  memoryDb.vendors[phone] = { phone, name, location: loc };
  return memoryDb.vendors[phone];
}

async function createDelivery(delivery) {
  const fee = delivery.deliveryFee || 1500;
  const trackingCode = delivery.trackingCode || `AK${Math.floor(100000 + Math.random() * 900000)}`;

  if (isConnected) {
    try {
      const vendorObj = await Vendor.findOne({ phone: delivery.vendorPhone });
      const newJob = await Job.create({
        orderNumber: trackingCode,
        trackingCode: trackingCode,
        vendorId: vendorObj ? vendorObj._id : null,
        vendorPhone: delivery.vendorPhone,
        vendor: {
          name: vendorObj ? vendorObj.name : "WhatsApp Vendor",
          address: delivery.pickup || (vendorObj ? vendorObj.location : "Kaduna"),
          itemsDescription: `${delivery.category || "Package"} (${delivery.size || "Small"})`,
          fragile: false,
        },
        customer: {
          name: "WhatsApp Customer",
          address: delivery.dropoff || delivery.address || "Kaduna",
          phone: delivery.customerPhone || "",
        },
        deliveryFee: fee,
        codAmount: delivery.codAmount || 0,
        amountFormatted: `₦${fee.toLocaleString()}`,
        category: delivery.category || "General Delivery",
        packageSize: delivery.size || "Small",
        status: "available",
      });

      return {
        id: newJob._id.toString(),
        tracking_code: newJob.trackingCode,
        trackingCode: newJob.trackingCode,
        vendor_phone: newJob.vendorPhone,
        pickup: newJob.vendor.address,
        dropoff: newJob.customer.address,
        address: newJob.customer.address,
        customer_phone: newJob.customer.phone,
        customerPhone: newJob.customer.phone,
        status: newJob.status,
      };
    } catch (err) {
      console.error("DB createDelivery error:", err.message);
    }
  }

  const newDelivery = {
    id: `mem-${memoryDb.deliveries.length + 1}`,
    vendor_phone: delivery.vendorPhone,
    pickup: delivery.pickup || "",
    dropoff: delivery.dropoff || delivery.address || "",
    address: delivery.dropoff || delivery.address || "",
    item: delivery.category || "Package",
    status: "available",
    tracking_code: trackingCode,
    trackingCode: trackingCode,
    customer_phone: delivery.customerPhone || "",
    customerPhone: delivery.customerPhone || "",
    rider_lat: null,
    rider_lng: null,
    rider_updated_at: null,
  };
  memoryDb.deliveries.push(newDelivery);
  return newDelivery;
}

async function getSession(phone) {
  if (isConnected) {
    try {
      const sess = await Session.findOne({ phone });
      if (sess && sess.session_data) {
        return sess.session_data;
      }
    } catch (err) {
      console.error("DB getSession error:", err.message);
    }
  }
  return memoryDb.sessions[phone] || { step: "menu", draftDelivery: {} };
}

async function saveSession(phone, sessionData) {
  if (isConnected) {
    try {
      await Session.findOneAndUpdate(
        { phone },
        { session_data: sessionData },
        { upsert: true }
      );
      memoryDb.sessions[phone] = sessionData;
      return;
    } catch (err) {
      console.error("DB saveSession error:", err.message);
    }
  }
  memoryDb.sessions[phone] = sessionData;
}

async function updateDeliveryStatus(deliveryId, status) {
  if (isConnected) {
    try {
      const job = await Job.findOneAndUpdate(
        { $or: [{ _id: mongoose.Types.ObjectId.isValid(deliveryId) ? deliveryId : null }, { trackingCode: deliveryId }, { orderNumber: deliveryId }] },
        { status },
        { new: true }
      );
      if (job) return job;
    } catch (err) {
      console.error("DB updateDeliveryStatus error:", err.message);
    }
  }
  const delivery = memoryDb.deliveries.find(d => d.id === deliveryId || d.tracking_code === deliveryId);
  if (delivery) {
    delivery.status = status;
    return delivery;
  }
  return null;
}

async function cancelDelivery(deliveryId) {
  if (isConnected) {
    try {
      const job = await Job.findOneAndUpdate(
        {
          $or: [{ _id: mongoose.Types.ObjectId.isValid(deliveryId) ? deliveryId : null }, { trackingCode: deliveryId }, { orderNumber: deliveryId }],
          status: { $in: ["available", "searching"] },
        },
        { status: "cancelled" },
        { new: true }
      );
      if (job) {
        return {
          result: "cancelled",
          delivery: {
            id: job._id.toString(),
            tracking_code: job.trackingCode || job.orderNumber,
            status: job.status,
          },
        };
      }

      const existing = await Job.findOne({
        $or: [{ _id: mongoose.Types.ObjectId.isValid(deliveryId) ? deliveryId : null }, { trackingCode: deliveryId }, { orderNumber: deliveryId }],
      });
      if (existing) {
        return {
          result: "not_cancellable",
          delivery: {
            id: existing._id.toString(),
            tracking_code: existing.trackingCode || existing.orderNumber,
            status: existing.status,
          },
        };
      }
      return { result: "not_found", delivery: null };
    } catch (err) {
      console.error("DB cancelDelivery error:", err.message);
    }
  }

  const delivery = memoryDb.deliveries.find(d => d.id === deliveryId || d.tracking_code === deliveryId);
  if (!delivery) return { result: "not_found", delivery: null };
  if (delivery.status !== "available" && delivery.status !== "searching") {
    return { result: "not_cancellable", delivery };
  }
  delivery.status = "cancelled";
  return { result: "cancelled", delivery };
}

async function markPickedUp(deliveryId) {
  if (isConnected) {
    try {
      const job = await Job.findOneAndUpdate(
        {
          $or: [{ _id: mongoose.Types.ObjectId.isValid(deliveryId) ? deliveryId : null }, { trackingCode: deliveryId }, { orderNumber: deliveryId }],
          status: { $in: ["available", "accepted", "heading_to_pickup", "at_pickup"] },
        },
        { status: "heading_to_dropoff" },
        { new: true }
      );
      return job;
    } catch (err) {
      console.error("DB markPickedUp error:", err.message);
    }
  }
  const delivery = memoryDb.deliveries.find(d => d.id === deliveryId || d.tracking_code === deliveryId);
  if (delivery) {
    delivery.status = "in_transit";
    return delivery;
  }
  return null;
}

async function updateRiderLocation(trackingCode, lat, lng) {
  if (isConnected) {
    try {
      const job = await Job.findOneAndUpdate(
        { $or: [{ trackingCode }, { orderNumber: trackingCode }] },
        { riderLat: lat, riderLng: lng, riderUpdatedAt: new Date() },
        { new: true }
      );
      return job;
    } catch (err) {
      console.error("DB updateRiderLocation error:", err.message);
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
      const job = await Job.findOne({
        $or: [{ trackingCode }, { orderNumber: trackingCode }],
      }).populate("riderId");

      if (job) {
        return {
          id: job._id.toString(),
          tracking_code: job.trackingCode || job.orderNumber,
          trackingCode: job.trackingCode || job.orderNumber,
          vendor_phone: job.vendorPhone,
          pickup: job.vendor?.address || "Kaduna",
          dropoff: job.customer?.address || "Kaduna",
          address: job.customer?.address || "Kaduna",
          item: job.category || job.vendor?.itemsDescription || "Package",
          status: job.status,
          customer_phone: job.customer?.phone || "",
          customerPhone: job.customer?.phone || "",
          rider_lat: job.riderLat,
          rider_lng: job.riderLng,
          rider_updated_at: job.riderUpdatedAt,
          riderName: job.riderName || (job.riderId ? job.riderId.personalDetails?.fullName : ""),
          riderPhone: job.riderId ? job.riderId.phone : "",
        };
      }
    } catch (err) {
      console.error("DB getDeliveryByTrackingCode error:", err.message);
    }
  }
  return memoryDb.deliveries.find(d => d.tracking_code === trackingCode || d.trackingCode === trackingCode) || null;
}

async function getDeliveriesByVendor(vendorPhone) {
  if (isConnected) {
    try {
      const jobs = await Job.find({ vendorPhone }).sort({ createdAt: -1 }).limit(5);
      return jobs.map(j => ({
        id: j._id.toString(),
        tracking_code: j.trackingCode || j.orderNumber,
        trackingCode: j.trackingCode || j.orderNumber,
        dropoff: j.customer?.address || "Kaduna",
        address: j.customer?.address || "Kaduna",
        status: j.status,
      }));
    } catch (err) {
      console.error("DB getDeliveriesByVendor error:", err.message);
    }
  }
  return memoryDb.deliveries
    .filter(d => d.vendor_phone === vendorPhone)
    .slice(-5)
    .reverse();
}

async function clearSession(phone) {
  const defaultSession = { step: "menu", draftDelivery: {} };
  await saveSession(phone, defaultSession);
}

module.exports = {
  getVendor,
  createVendor,
  createDelivery,
  updateDeliveryStatus,
  cancelDelivery,
  markPickedUp,
  updateRiderLocation,
  getDeliveryByTrackingCode,
  getDeliveriesByVendor,
  getSession,
  saveSession,
  clearSession,
};
