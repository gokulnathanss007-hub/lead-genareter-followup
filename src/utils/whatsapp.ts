// ── Shared Twilio WhatsApp helper ─────────────────────────────────────────────
// Single place for all outbound WhatsApp messages.
// Reads credentials from env vars so callers only supply the destination and text.

/**
 * Sends a WhatsApp message via Twilio.
 *
 * @param to      Recipient in Twilio format — must include the `whatsapp:` prefix,
 *                e.g. `"whatsapp:+923001234567"`. Twilio's webhook `From` field
 *                already arrives in this format, so you can pass it through directly.
 * @param message The text body to send.
 */
export async function sendWhatsAppMessage(
  to: string,
  message: string
): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!accountSid) throw new Error("TWILIO_ACCOUNT_SID is not set");
  if (!authToken)  throw new Error("TWILIO_AUTH_TOKEN is not set");
  if (!from)       throw new Error("TWILIO_WHATSAPP_NUMBER is not set");

  const url         = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization:  `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: message }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`[Twilio] Send failed — HTTP ${response.status}: ${errorText}`);
  }
}
