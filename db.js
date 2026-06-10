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
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
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
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
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
      console.error("DB getVendor error:", err);
    }
  }
  return memoryDb.vendors[phone] || null;
}

async function createVendor(phone, name) {
  if (pool) {
    try {
      const res = await pool.query(
        "INSERT INTO vendors (phone, name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET name = $2 RETURNING *",
        [phone, name]
      );
      return res.rows[0];
    } catch (err) {
      console.error("DB createVendor error:", err);
    }
  }
  memoryDb.vendors[phone] = { phone, name };
  return memoryDb.vendors[phone];
}

async function createDelivery(delivery) {
  if (pool) {
    try {
      const res = await pool.query(
        `INSERT INTO deliveries (vendor_phone, pickup, dropoff, item, status, tracking_code) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          delivery.vendorPhone,
          delivery.pickup || "",
          delivery.dropoff || delivery.address || "",
          delivery.item || delivery.category || "",
          delivery.status || "searching",
          delivery.trackingCode || ""
        ]
      );
      return res.rows[0];
    } catch (err) {
      console.error("DB createDelivery error:", err);
    }
  }
  
  const newDelivery = {
    id: memoryDb.deliveries.length + 1,
    vendor_phone: delivery.vendorPhone,
    pickup: delivery.pickup || "",
    dropoff: delivery.dropoff || delivery.address || "",
    item: delivery.item || delivery.category || "",
    status: delivery.status || "searching",
    tracking_code: delivery.trackingCode || ""
  };
  memoryDb.deliveries.push(newDelivery);
  return newDelivery;
}

async function getSession(phone) {
  if (pool) {
    try {
      const res = await pool.query("SELECT session_data FROM sessions WHERE phone = $1", [phone]);
      return res.rows[0]?.session_data || { step: 'menu', draftDelivery: {} };
    } catch (err) {
      console.error("DB getSession error:", err);
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
      return;
    } catch (err) {
      console.error("DB saveSession error:", err);
    }
  }
  memoryDb.sessions[phone] = sessionData;
}

async function clearSession(phone) {
  const defaultSession = { step: 'menu', draftDelivery: {} };
  await saveSession(phone, defaultSession);
}

module.exports = {
  getVendor,
  createVendor,
  createDelivery,
  getSession,
  saveSession,
  clearSession
};
