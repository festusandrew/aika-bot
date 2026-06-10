const sessions = new Map();

async function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { step: 'menu', draftDelivery: {} });
  }
  return sessions.get(phone);
}

async function saveSession(phone, sessionData) {
  sessions.set(phone, sessionData);
}

async function clearSession(phone) {
  sessions.set(phone, { step: 'menu', draftDelivery: {} });
}

module.exports = {
  getSession,
  saveSession,
  clearSession
};
