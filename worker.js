// worker.js
const amqp = require("amqplib");
const { createClient } = require("redis");
const tasks = require("./tasks");

const RABBIT_URL = process.env.RABBIT_URL || "amqp://rabbitmq:5672";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const QUEUE = "tasks";
const DLX = "dlx";
const DLQ = "tasks.dlq";
const MAX_RETRIES = 3; // Based upon user

// retry‐connect helper
async function connectRabbitWithRetry(url, retries = 10, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await amqp.connect(url);
    } catch {
      console.log(
        `RabbitMQ not ready, retry #${i}. Waiting ${(delay / 1000).toFixed(
          1
        )}s…`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`Cannot connect to RabbitMQ at ${url}`);
}

async function main() {
  // — connect to Redis (for pub/sub)
  const redisPub = createClient({ url: REDIS_URL });
  await redisPub.connect();

  // — connect & setup RabbitMQ
  const conn = await connectRabbitWithRetry(RABBIT_URL);
  const ch = await conn.createChannel();

  // only work on one message at a time (fair dispatch)
  await ch.prefetch(1);

  // declare dead‐letter exchange + queue
  await ch.assertExchange(DLX, "fanout", { durable: true });
  await ch.assertQueue(DLQ, { durable: true });
  await ch.bindQueue(DLQ, DLX, "");

  // declare main queue with DLX attached
  await ch.assertQueue(QUEUE, {
    durable: true,
    arguments: { "x-dead-letter-exchange": DLX },
  });

  console.log("→ RabbitMQ ready, forking workers…");

  ch.consume(
    QUEUE,
    async (msg) => {
      if (!msg) return;

      const { id, type, payload } = JSON.parse(msg.content.toString());
      const headers = msg.properties.headers || {};
      const attempts = headers["x-attempts"] || 0;

      // 1) broadcast “started”
      await redisPub.publish(
        "task_updates",
        JSON.stringify({
          id,
          type,
          status: "started",
          timestamp: Date.now(),
          workerPid: process.pid,
        })
      );

      // 2) invoke handler
      let status, result;
      try {
        if (typeof tasks[type] !== "function") {
          throw new Error(`No handler for task type: ${type}`);
        }
        result = await tasks[type](payload);
        status = "completed";
      } catch (err) {
        status = "failed";
        result = err.message;
      }

      // 3) persist final status + result
      await redisPub.hSet(`task:${id}`, {
        status,
        result: JSON.stringify(result),
        timestamp: Date.now(),
        workerPid: process.pid,
      });

      // 4) broadcast “completed” or “failed”
      await redisPub.publish(
        "task_updates",
        JSON.stringify({
          id,
          type,
          status,
          timestamp: Date.now(),
          workerPid: process.pid,
          result,
        })
      );

      // 5) ack / retry / dead‐letter
      if (status === "completed") {
        ch.ack(msg);
      } else if (attempts < MAX_RETRIES) {
        ch.ack(msg);
        ch.sendToQueue(QUEUE, Buffer.from(msg.content), {
          persistent: true,
          headers: { ...headers, "x-attempts": attempts + 1 },
        });
      } else {
        ch.nack(msg, false, false);
      }

      // 6) report new queue length
      const { messageCount } = await ch.checkQueue(QUEUE);
      await redisPub.publish("queue_length", String(messageCount));
    },
    { noAck: false }
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
