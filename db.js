const { Pool } = require("pg");

let pool = null;
const memoryDb = {
  vendors: {},
  deliveries: [],
  sessions: {}
};


if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  // Self-initialize tables
  const initDb = async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS vendors (
          phone VARCHAR PRIMARY KEY,
          name VARCHAR,
          location VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        ALTER TABLE vendors ADD COLUMN IF NOT EXISTS location VARCHAR;
        CREATE TABLE IF NOT EXISTS sessions (
          phone VARCHAR PRIMARY KEY,
          session_data JSONB,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS deliveries (
          id SERIAL PRIMARY KEY,
          vendor_phone VARCHAR REFERENCES vendors(phone),
          pickup VARCHAR,
          dropoff VARCHAR,
          item VARCHAR,
          status VARCHAR,
          tracking_code VARCHAR,
          customer_phone VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS rider_lat DOUBLE PRECISION;
        ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS rider_lng DOUBLE PRECISION;
        ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS rider_updated_at TIMESTAMP;
      `);
      console.log("PostgreSQL database tables initialized successfully.");
    } catch (err) {
      console.error("Failed to initialize PostgreSQL tables, falling back to in-memory:", err);
      pool = null; // Fallback
    }
  };
  initDb();
} else {
  console.log("No DATABASE_URL found. Running with in-memory database.");
}

async function getVendor(phone) {
  if (pool) {
    try {
      const res = await pool.query("SELECT * FROM vendors WHERE phone = $1", [phone]);
      return res.rows[0] || null;
    } catch (err) {
      console.error("DB getVendor error, falling back to memory:", err);
    }
  }
  return memoryDb.vendors[phone] || null;
}

async function createVendor(phone, name, location = null) {
  if (pool) {
    try {
      const res = await pool.query(
        "INSERT INTO vendors (phone, name, location) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET name = $2, location = COALESCE($3, vendors.location) RETURNING *",
        [phone, name, location]
      );
      return res.rows[0];
    } catch (err) {
      console.error("DB createVendor error, falling back to memory:", err);
    }
  }
  const existing = memoryDb.vendors[phone] || {};
  memoryDb.vendors[phone] = { phone, name, location: location || existing.location || null };
  return memoryDb.vendors[phone];
}

async function createDelivery(delivery) {
  if (pool) {
    try {
      const res = await pool.query(
        `INSERT INTO deliveries (vendor_phone, pickup, dropoff, item, status, tracking_code, customer_phone) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          delivery.vendorPhone,
          delivery.pickup || "",
          delivery.dropoff || delivery.address || "",
          delivery.item || delivery.category || "",
          delivery.status || "searching",
          delivery.trackingCode || "",
          delivery.customerPhone || ""
        ]
      );
      return res.rows[0];
    } catch (err) {
      console.error("DB createDelivery error, falling back to memory:", err);
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
    rider_lat: null,
    rider_lng: null,
    rider_updated_at: null
  };
  memoryDb.deliveries.push(newDelivery);
  return newDelivery;
}

async function getSession(phone) {
  if (pool) {
    try {
      const res = await pool.query("SELECT session_data FROM sessions WHERE phone = $1", [phone]);
      if (res.rows[0]) {
        return res.rows[0].session_data;
      }
    } catch (err) {
      console.error("DB getSession error, falling back to memory:", err);
    }
  }
  return memoryDb.sessions[phone] || { step: 'menu', draftDelivery: {} };
}

async function saveSession(phone, sessionData) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO sessions (phone, session_data, updated_at) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (phone) DO UPDATE SET session_data = $2, updated_at = NOW()`,
        [phone, sessionData]
      );
      memoryDb.sessions[phone] = sessionData; // Warm cache sync
      return;
    } catch (err) {
      console.error("DB saveSession error, falling back to memory:", err);
    }
  }
  memoryDb.sessions[phone] = sessionData;
}

async function updateDeliveryStatus(deliveryId, status) {
  if (pool) {
    try {
      // Try updating by ID first (if it's an integer)
      const numericId = parseInt(deliveryId, 10);
      if (!isNaN(numericId)) {
        const res = await pool.query(
          "UPDATE deliveries SET status = $1 WHERE id = $2 RETURNING *",
          [status, numericId]
        );
        if (res.rows[0]) return res.rows[0];
      }
      
      // Fallback/alternative: update by tracking code
      const resTracking = await pool.query(
        "UPDATE deliveries SET status = $1 WHERE tracking_code = $2 RETURNING *",
        [status, deliveryId]
      );
      return resTracking.rows[0] || null;
    } catch (err) {
      console.error("DB updateDeliveryStatus error, falling back to memory:", err);
    }
  }

  // Fallback in-memory
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

// Cancel a delivery only while it is still cancellable (status 'searching').
// Returns { result: 'cancelled' | 'not_cancellable' | 'not_found', delivery }.
async function cancelDelivery(deliveryId) {
  if (pool) {
    try {
      const numericId = parseInt(deliveryId, 10);
      // Atomic guarded update: only cancels rows still in 'searching'
      if (!isNaN(numericId)) {
        const res = await pool.query(
          "UPDATE deliveries SET status = 'cancelled' WHERE id = $1 AND status = 'searching' RETURNING *",
          [numericId]
        );
        if (res.rows[0]) return { result: 'cancelled', delivery: res.rows[0] };
      }
      const resTracking = await pool.query(
        "UPDATE deliveries SET status = 'cancelled' WHERE tracking_code = $1 AND status = 'searching' RETURNING *",
        [deliveryId]
      );
      if (resTracking.rows[0]) return { result: 'cancelled', delivery: resTracking.rows[0] };

      // Nothing cancelled — figure out whether it exists but is past cancellation, or not found
      const existing = await pool.query(
        "SELECT * FROM deliveries WHERE id = $1 OR tracking_code = $2",
        [isNaN(numericId) ? -1 : numericId, deliveryId]
      );
      if (existing.rows[0]) return { result: 'not_cancellable', delivery: existing.rows[0] };
      return { result: 'not_found', delivery: null };
    } catch (err) {
      console.error("DB cancelDelivery error, falling back to memory:", err);
    }
  }

  // Fallback in-memory
  const numericId = parseInt(deliveryId, 10);
  const delivery = memoryDb.deliveries.find(
    d => (!isNaN(numericId) && d.id === numericId) || d.tracking_code === deliveryId
  );
  if (!delivery) return { result: 'not_found', delivery: null };
  if (delivery.status !== 'searching') return { result: 'not_cancellable', delivery };
  delivery.status = 'cancelled';
  return { result: 'cancelled', delivery };
}

// Move a delivery from 'searching' to 'in_transit' (rider collected the package).
// Guarded so it never overrides a cancellation. Returns the updated row or null.
async function markPickedUp(deliveryId) {
  if (pool) {
    try {
      const numericId = parseInt(deliveryId, 10);
      if (!isNaN(numericId)) {
        const res = await pool.query(
          "UPDATE deliveries SET status = 'in_transit' WHERE id = $1 AND status = 'searching' RETURNING *",
          [numericId]
        );
        return res.rows[0] || null;
      }
      const resTracking = await pool.query(
        "UPDATE deliveries SET status = 'in_transit' WHERE tracking_code = $1 AND status = 'searching' RETURNING *",
        [deliveryId]
      );
      return resTracking.rows[0] || null;
    } catch (err) {
      console.error("DB markPickedUp error, falling back to memory:", err);
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

// Record the rider's latest GPS position for a delivery, keyed by tracking code.
// Returns the updated delivery, or null if no delivery matches the code.
async function updateRiderLocation(trackingCode, lat, lng) {
  if (pool) {
    try {
      const res = await pool.query(
        "UPDATE deliveries SET rider_lat = $1, rider_lng = $2, rider_updated_at = NOW() WHERE tracking_code = $3 RETURNING *",
        [lat, lng, trackingCode]
      );
      return res.rows[0] || null;
    } catch (err) {
      console.error("DB updateRiderLocation error, falling back to memory:", err);
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
  if (pool) {
    try {
      const res = await pool.query("SELECT * FROM deliveries WHERE tracking_code = $1", [trackingCode]);
      return res.rows[0] || null;
    } catch (err) {
      console.error("DB getDeliveryByTrackingCode error, falling back to memory:", err);
    }
  }
  return memoryDb.deliveries.find(d => d.tracking_code === trackingCode) || null;
}

async function getDeliveriesByVendor(vendorPhone) {
  if (pool) {
    try {
      const res = await pool.query(
        "SELECT * FROM deliveries WHERE vendor_phone = $1 ORDER BY created_at DESC LIMIT 5",
        [vendorPhone]
      );
      return res.rows;
    } catch (err) {
      console.error("DB getDeliveriesByVendor error, falling back to memory:", err);
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
