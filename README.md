AIKA BOT - BACKEND ARCHITECTURE AND DEVELOPER DOCUMENTATION

Aika is a WhatsApp-based logistics and delivery assistant for vendors in Nigeria. The platform enables vendors to register their businesses, create individual or batch deliveries, track orders with live GPS maps, and manage their accounts through interactive WhatsApp menus or natural-language messages.


ARCHITECTURAL OVERVIEW

The application is built on Node.js and Express, serving two main roles:
1. WhatsApp Cloud API Webhook Listener: Receives real-time incoming messages/events from Meta's WhatsApp API, routes them through a state-machine conversation engine, and sends interactive text/button responses back to vendors.
2. REST API Endpoint for Rider Location Updates: Exposes a secure endpoint (POST /rider/location) used by rider applications to report live GPS coordinates.


KEY BACKEND CAPABILITIES AND RECENT UPDATES

1. AI-Powered Natural Language Processing (ai.js)
- Gemini Integration: Uses @google/generative-ai with gemini-1.5-flash to process free-form vendor inputs when they bypass or comment outside structured button choices.
- Single-Pass Intent and Entity Extraction: Executes understandMessage(text), returning structured JSON classifying user intent:
  - create_delivery: Extracts dropoff address, customerPhone, item, and codAmount.
  - track_order: Extracts tracking codes (e.g. AK123456).
  - question / greeting: Provides grounded, concise answers based on service facts (pricing, rules, locations).
  - unknown: Safe fallback to the standard menu without crashing.
- Smart Flow Shortcutting: When AI pre-populates delivery parameters (such as customer phone or address), server.js intelligently skips redundant prompts in the interactive button flow.

2. Live Rider Location Tracking (POST /rider/location)
- GPS Telemetry Endpoint: Allows external rider tracking apps to post real-time coordinates (lat, lng, trackingCode).
- Authentication: Secured via x-rider-key HTTP header checked against the RIDER_API_KEY environment variable.
- Dynamic Maps Links: Order tracking responses automatically generate Google Maps URLs pointing directly to the rider's latest reported coordinates when available.

3. Batch Deliveries and Single-Rider Grouping
- Vendors can stage multiple dropoff destinations into a single batch (session.batch) via the "Add another delivery" action (add_stop).
- All items in a batch share the vendor's business location as the single pickup point and are assigned to a single rider upon confirmation.
- Individual tracking codes (AKxxxxxx) are issued per delivery while supporting batch-wide status checks and atomic batch cancellations.

4. Concurrency Guarded Lifecycle and Status Machine
- Delivery Statuses: searching -> in_transit -> delivered (or cancelled).
- Atomic DB Guards:
  - cancelDelivery(): Performs atomic UPDATE queries restricted strictly to rows with status = 'searching'. Rejects cancellation attempts if the delivery has reached in_transit.
  - markPickedUp(): Guarded UPDATE transition (searching -> in_transit) that will never overwrite a prior vendor cancellation.

5. Resilient Data Layer and Dual Persistence (db.js)
- PostgreSQL Connection Pool: Uses pg.Pool with auto-migration (CREATE TABLE IF NOT EXISTS) for vendors, deliveries, and sessions.
- Zero-Downtime Memory Fallback: If DATABASE_URL is omitted or PostgreSQL becomes unreachable, the database module seamlessly fails over to an in-memory datastore (memoryDb).
- Warm Cache Session Sync: Session updates sync to memory cache and DB synchronously to ensure rapid conversation state resolution.


CODEBASE FILE BREAKDOWN

server.js
  Main Express application entrypoint. Webhook verification, message router, state-machine transitions, timer simulations for rider pickup, WhatsApp API HTTP client (sendText, sendButtons).

ai.js
  Google Gemini NLP integration layer. understandMessage(text) - intent classification, entity parsing, service facts grounding, and JSON normalization.

db.js
  Data access layer (PostgreSQL + In-Memory). getVendor, createVendor, createDelivery, updateDeliveryStatus, cancelDelivery, markPickedUp, updateRiderLocation, getDeliveryByTrackingCode, getDeliveriesByVendor, getSession, saveSession, clearSession.

session.js
  Session helper wrapper. getSession, saveSession, clearSession delegating to db.js.


API ENDPOINTS REFERENCE

1. Health Check
- Method: GET /
- Response: 200 OK - "Aika bot is live"

2. Rider Location Sync
- Method: POST /rider/location
- Headers: x-rider-key: <RIDER_API_KEY> (if RIDER_API_KEY is configured)
- Request Body:
  {
    "trackingCode": "AK123456",
    "lat": 6.6018,
    "lng": 3.3515
  }
- Responses:
  - 200 OK: { "ok": true }
  - 401 Unauthorized: { "error": "unauthorized" }
  - 400 Bad Request: { "error": "trackingCode is required" } or invalid coordinates
  - 404 Not Found: { "error": "delivery not found" }

3. WhatsApp Webhook Verification
- Method: GET /webhook
- Query Params: hub.mode=subscribe, hub.verify_token=aika_verify, hub.challenge=<challenge>
- Response: Returns hub.challenge string on success.

4. WhatsApp Event Receiver
- Method: POST /webhook
- Request Body: Meta WhatsApp Webhook Payload. Parses incoming text, quick reply button IDs (button_reply.id), and user phone numbers.


DATABASE SCHEMA

Table: vendors
- phone (VARCHAR, PRIMARY KEY): Vendor's WhatsApp phone number
- name (VARCHAR): Registered business name
- location (VARCHAR): Pickup address for vendor's deliveries
- created_at (TIMESTAMP, DEFAULT CURRENT_TIMESTAMP): Registration timestamp

Table: deliveries
- id (SERIAL, PRIMARY KEY): Auto-incrementing internal ID
- vendor_phone (VARCHAR, REFERENCES vendors): Associated vendor
- pickup (VARCHAR): Pickup address
- dropoff (VARCHAR): Destination delivery address
- item (VARCHAR): Item description / category
- status (VARCHAR): searching, in_transit, delivered, cancelled
- tracking_code (VARCHAR): Tracking reference code (AKxxxxxx)
- customer_phone (VARCHAR): Recipient phone number
- rider_lat (DOUBLE PRECISION): Latest rider latitude
- rider_lng (DOUBLE PRECISION): Latest rider longitude
- rider_updated_at (TIMESTAMP): Last timestamp of GPS telemetry update
- created_at (TIMESTAMP, DEFAULT CURRENT_TIMESTAMP): Order creation timestamp

Table: sessions
- phone (VARCHAR, PRIMARY KEY): Vendor's WhatsApp phone number
- session_data (JSONB): Current step state, draft delivery object, and active batch array
- updated_at (TIMESTAMP, DEFAULT CURRENT_TIMESTAMP): Last updated timestamp


ENVIRONMENT VARIABLES

Create a .env file in the project root:

PORT=3000
PHONE_NUMBER_ID=your_whatsapp_phone_number_id
WHATSAPP_TOKEN=your_whatsapp_access_token
WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_account_id
GEMINI_API_KEY=your_google_gemini_api_key
DATABASE_URL=postgres://username:password@localhost:5432/aikadb
RIDER_API_KEY=your_secret_rider_api_key


RUNNING LOCALLY

1. Install dependencies:
   npm install

2. Configure Environment:
   Ensure .env contains valid credentials. Node.js 18+ is required to load environment variables via --env-file=.env.

3. Start the application:
   npm start

4. Expose Webhook (Development):
   Use ngrok or similar tunneling tools to expose port 3000 over HTTPS for Meta Webhook testing:
   ngrok http 3000


DELIVERY FEE SYSTEM

Fees are flat base rates determined by package size (in Nigerian Naira):
- Small (fits in bag): 1,500 Naira
- Medium (medium box): 2,500 Naira
- Large (heavy/bulky): 4,000 Naira
Note: Food and Clothing categories default to the Small package fee (1,500 Naira).


PRODUCTION SECURITY RECOMMENDATIONS

1. Webhook Signature Validation: Implement x-hub-signature-256 payload verification for incoming Meta POST requests in server.js.
2. Dynamic Verify Token: Move the hardcoded aika_verify query string token check into an environment variable (WEBHOOK_VERIFY_TOKEN).
3. API Keys: Ensure RIDER_API_KEY and GEMINI_API_KEY are kept confidential in secret managers.
