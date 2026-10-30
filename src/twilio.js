/**
 * Twilio Programmable Voice - outbound Calls REST API over plain fetch.
 * (Replaces the `twilio` npm SDK so the same code runs on Cloudflare Workers.)
 */

const API_BASE = 'https://api.twilio.com/2010-04-01';

export async function placeCall({ accountSid, authToken, to, from, origin, jobId }) {
  if (!accountSid || !authToken) {
    const err = new Error(
      'Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server, or add them in Settings -> API keys in the dashboard.'
    );
    err.status = 500;
    throw err;
  }

  const form = new URLSearchParams({
    To: to,
    From: from,
    Url: `${origin}/api/voice?job=${jobId}`,
    Method: 'POST',
    StatusCallback: `${origin}/api/status?job=${jobId}`,
    StatusCallbackMethod: 'POST',
    'StatusCallbackEvent[0]': 'initiated',
    'StatusCallbackEvent[1]': 'ringing',
    'StatusCallbackEvent[2]': 'answered',
    'StatusCallbackEvent[3]': 'completed',
  });

  const response = await fetch(`${API_BASE}/Accounts/${accountSid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(data.message || `Twilio error ${response.status}`);
    err.code = data.code;
    err.status = 502;
    throw err;
  }
  return data; // { sid, status, to, from, ... }
}
