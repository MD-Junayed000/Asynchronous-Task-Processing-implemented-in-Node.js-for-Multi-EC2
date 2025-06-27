// tasks.js

// simple sleep helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * “Send Email” task:
 * • payload: { recipient, subject, body }
 * • throws on any recipient containing “fail” to trigger retry / DLQ
 */
async function send_email_task(payload) {
  console.log(`📧 [Task] Sending email to ${payload.recipient}`);
  await sleep(500);

  if (payload.recipient.includes("fail")) {
    throw new Error("Simulated email failure");
  }

  return `Email successfully sent to ${payload.recipient}`;
}

/**
 * “Reverse Text” task:
 * • payload: { text }
 */
async function reverse_text_task(payload) {
  console.log(`🔁 [Task] Reversing text: "${payload.text}"`);
  await sleep(500);

  return payload.text.split("").reverse().join("");
}

/**
 * “Fake Sentiment Analysis” task:
 * • payload: { text }
 * • returns “positive” if “good” appears, otherwise “negative”
 */
async function fake_sentiment_analysis(payload) {
  console.log(`🕵️‍♀️ [Task] Analyzing sentiment for: "${payload.text}"`);
  await sleep(500);

  return payload.text.toLowerCase().includes("good") ? "positive" : "negative";
}

module.exports = {
  send_email_task,
  reverse_text_task,
  fake_sentiment_analysis,
};
