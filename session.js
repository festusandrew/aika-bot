const db = require("./db");

async function getSession(phone) {
  return await db.getSession(phone);
}

async function saveSession(phone, sessionData) {
  await db.saveSession(phone, sessionData);
}

async function clearSession(phone) {
  await db.clearSession(phone);
}

module.exports = {
  getSession,
  saveSession,
  clearSession
};
