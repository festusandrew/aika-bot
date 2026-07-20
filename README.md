AIKA BOT

Aika is a WhatsApp-based logistics assistant for delivery vendors in Nigeria. Vendors chat with the bot on WhatsApp to register their business, create deliveries, track orders, and view their account. The bot guides them through each step using text prompts and tappable reply buttons, then simulates rider assignment and pickup.


OVERVIEW

The bot runs as an Express web server that receives WhatsApp messages through the WhatsApp Cloud API webhook. Each incoming message is matched against the vendor's saved conversation state (their session) and routed to the right step of the flow. Replies are sent back to the vendor as either plain text or interactive button messages.

Data is stored in PostgreSQL when a database connection string is provided. If no database is configured, the bot automatically falls back to an in-memory store so it can still run for local testing. The in-memory store is not persistent and is cleared when the process restarts.


KEY FEATURES

Vendor onboarding. First-time users are asked for their business name and business location. The location becomes the pickup point for all of that vendor's deliveries.

Guided delivery creation. The bot collects the customer address, customer phone number, item category, package size (when needed), and payment method one step at a time, then shows a summary for confirmation.

Batch deliveries. A vendor can add several deliveries in a single flow using the "Add another delivery" button. All deliveries in a batch share the same pickup (the vendor's registered location) and are committed together. Each delivery still gets its own tracking code so it can be tracked individually.

One rider per batch. When a batch is confirmed, a single rider is assigned to handle all deliveries in that batch at once. The rider message lists every delivery being carried, and a single cancel action covers the whole group.

Cancellation window. A delivery can only be cancelled while its status is "searching" (a rider has not yet collected the package). Once the rider reaches the pickup and collects the package, the delivery moves to "in_transit" and can no longer be cancelled. Any attempt to cancel after that point is rejected with an explanation.

Order tracking. Vendors can enter a tracking code to see the current status, item, dropoff, customer phone, and a Google Maps link to the destination.

Account view. Vendors can view their business details and their five most recent deliveries with status indicators.

Cash on delivery. Vendors can mark an item as prepaid or ask the rider to collect the item cost in cash. The cash amount is captured and shown in the summary.

Delivery fee calculation. A base fee is applied based on package size: Small is 1500, Medium is 2500, and Large is 4000 (all in Naira).


PROJECT STRUCTURE

server.js
   The main application. Sets up the Express server, handles the WhatsApp webhook verification and message routing, runs the conversation flow, calculates fees, generates tracking codes, simulates rider assignment and pickup, and sends WhatsApp messages.

db.js
   The data layer. Manages the PostgreSQL connection pool, creates tables on startup, and provides all read and write functions for vendors, deliveries, and sessions. Every function falls back to the in-memory store if the database is unavailable.

session.js
   A thin wrapper around the session functions in db.js. Provides getSession, saveSession, and clearSession for the rest of the app to use.

package.json
   Project metadata, the start script, and the dependency list.

.env
   Environment variables (not committed to version control).


REQUIREMENTS

Node.js version 18 or newer is recommended, because the start script uses the built-in "--env-file" flag to load the .env file.

A WhatsApp Business account with access to the WhatsApp Cloud API through Meta.

A Google Gemini API key (used by the optional natural-language delivery parser).

A PostgreSQL database is optional. Without one, the bot runs on the in-memory store.


ENVIRONMENT VARIABLES

Create a file named .env in the project root with the following keys.

PORT
   The port the server listens on. Defaults to 3000 if not set.

GEMINI_API_KEY
   The Google Gemini API key used by the delivery text parser.

PHONE_NUMBER_ID
   The WhatsApp Cloud API phone number identifier used to send messages.

WHATSAPP_TOKEN
   The access token used to authenticate calls to the WhatsApp Cloud API.

WHATSAPP_BUSINESS_ACCOUNT_ID
   The WhatsApp Business account identifier.

DATABASE_URL
   The PostgreSQL connection string. If this is omitted, the bot uses the in-memory store.

The .env file is ignored by git and must never be committed. Keep tokens and connection strings private.


INSTALLATION AND RUNNING

Step one. Install the dependencies.
   npm install

Step two. Create the .env file described above and fill in your own values.

Step three. Start the server.
   npm start

The start script runs "node --env-file=.env server.js", which loads the environment variables and launches the server. When it starts you will see a log line reporting the port it is running on.

Step four. Expose the server to the internet so WhatsApp can reach the webhook. During development a tunneling tool such as ngrok can be used to get a public HTTPS URL that forwards to your local port.


WEBHOOK SETUP

The server exposes two routes for WhatsApp.

Verification route. A GET request to /webhook is used by Meta to verify the endpoint. The server checks that the mode is "subscribe" and that the verify token equals "aika_verify". If both match, it returns the challenge value. Configure the same verify token, "aika_verify", in the Meta app dashboard.

Message route. A POST request to /webhook receives incoming messages. The server reads the first message from the payload, extracts the sender phone number, the message text, and any button reply identifier, then processes it.

There is also a health check route. A GET request to the root path / returns a short "Aika bot is live" message. This is useful for hosting platforms that ping the service to confirm it is running.


CONVERSATION FLOW

The bot tracks where each vendor is in the conversation using a session step value. The main steps are described below in the order a vendor usually moves through them.

Onboarding. If the sender is not a known vendor, the bot asks for the business name (step onboarding_name), then the business location (step onboarding_location). Once both are provided, the vendor record is created and the main menu is shown.

Main menu. A registered vendor sees three buttons: New delivery, Track order, and My account.

New delivery. Selecting New delivery clears any previous draft and batch, then asks for the customer delivery address (step awaiting_address_input). The vendor confirms or edits the address, then enters the customer phone number (step awaiting_customer_phone), which is validated to contain at least five digits.

Item category. The vendor chooses Food, Clothing, or Others (step awaiting_category). Food and Clothing skip straight to payment. Others requires a package size.

Package size. For the Others category, the vendor picks Small, Medium, or Large (step awaiting_package_size). This size drives the delivery fee.

Payment method. The vendor chooses whether the customer has already paid or whether the rider should collect cash on delivery (step awaiting_payment_method). If cash is chosen, the bot asks for the item price to collect (step awaiting_cod_amount).

Summary and confirmation. The bot shows a summary of the delivery including drop address, customer phone, item, payment method, and delivery fee (step awaiting_confirmation). Three actions are offered: Confirm, Add another delivery, and Cancel. Choosing Add another delivery saves the current delivery to the batch and restarts the address step for the next one. Choosing Confirm commits every delivery in the batch.

Track order. Selecting Track order asks for a tracking code (step awaiting_tracking_code). The bot looks up the delivery and returns its status, item, dropoff, customer phone, and a maps link, or reports that the order was not found.

My account. Selecting My account shows the business name, registered phone, and the five most recent deliveries with a status indicator for each.


DELIVERY LIFECYCLE AND STATUS

A delivery moves through the following statuses.

searching
   The delivery has just been created and the system is looking for a rider. This is the only status during which the delivery can be cancelled.

in_transit
   The rider has reached the pickup, collected the package, and is heading to the dropoff. Cancellation is no longer allowed once a delivery reaches this status.

delivered
   The package has been delivered.

cancelled
   The delivery was cancelled while it was still in the searching status.

In the current build the rider assignment and pickup are simulated with timers to demonstrate the flow. About five seconds after a delivery is confirmed, a rider is assigned. About twenty seconds after confirmation, the rider is treated as having collected the package and the delivery moves to in_transit. In a production system these transitions would instead be driven by real rider events.


CANCELLATION RULES

Cancellation is guarded on both the server and the database so it cannot be bypassed by tapping an old button.

The cancelDelivery function in db.js performs an atomic update that only cancels a delivery whose status is still searching. It returns one of three results: cancelled when the delivery was still cancellable, not_cancellable when the delivery exists but has already been picked up, and not_found when no matching delivery exists.

The markPickedUp function moves a delivery from searching to in_transit and is written so it can never override a cancellation the vendor made in time.

For a batch handled by one rider, the cancel button carries every delivery identifier. When tapped, the bot reports which references were cancelled and which could no longer be cancelled because the rider had already collected them.


DATA STORAGE

When DATABASE_URL is set, the bot connects to PostgreSQL and creates three tables on startup if they do not already exist.

vendors
   Holds the vendor phone number as the primary key, the business name, the pickup location, and a created timestamp.

deliveries
   Holds an auto-incrementing identifier, the vendor phone, pickup, dropoff, item, status, tracking code, customer phone, and a created timestamp.

sessions
   Holds the vendor phone as the primary key, the session data as JSON, and an updated timestamp. This lets conversations continue correctly even across server restarts.

If the database is not configured or a query fails, the corresponding function falls back to an in-memory JavaScript store holding the same shapes of data. This keeps the bot working for local development, but the in-memory data is lost when the process stops.


TRACKING CODES AND FEES

Each delivery is assigned a tracking code in the form AK followed by six digits, for example AK123456. Codes are generated randomly at creation time.

The delivery fee is a flat base amount based on package size. Small is 1500, Medium is 2500, and Large is 4000, expressed in Nigerian Naira. Food and Clothing deliveries that skip the size step use the Small base fee.


NATURAL LANGUAGE PARSING

The project includes a parseDelivery helper that uses the Google Gemini model to extract delivery details from free-form text and return them as structured JSON. This is available for future use where a vendor types a full delivery request in one message rather than stepping through the guided buttons.


SECURITY NOTES

The webhook currently accepts posted messages without verifying the request signature from Meta. For a production deployment you should validate the signature header on incoming webhook requests so that only genuine WhatsApp calls are processed.

The verify token for webhook verification is currently a fixed value in the code. For production, move it into an environment variable and use a strong secret.

Never commit the .env file or any access tokens. Rotate any token that may have been exposed.


LICENSE

Add your chosen license here.
