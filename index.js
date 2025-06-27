// index.js
const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const { createClient } = require("redis");
const socketIo = require("socket.io");
const amqp = require("amqplib");
const { v4: uuidv4 } = require("uuid");

const RABBIT_URL = process.env.RABBIT_URL || "amqp://rabbitmq:5672";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const QUEUE = "tasks";
const DLX = "dlx";
const DLQ = "tasks.dlq";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectRabbitWithRetry(url, maxAtt = 10, delayMs = 5000) {
  let attempt = 0;
  while (attempt < maxAtt) {
    try {
      //const conn = await amqp.connect(url);
      const conn = await amqp.connect(RABBIT_URL, {
        clientProperties: { connection_name: `worker-${process.pid}` },
      });
      console.log("🐰 Connected to RabbitMQ");
      return conn; // ← make sure to return here!
    } catch (err) {
      attempt++;
      console.warn(
        `RabbitMQ not ready (attempt ${attempt}/${maxAtt}), retrying in ${
          delayMs / 1000
        }s…`
      );
      await sleep(delayMs);
    }
  }
  throw new Error("⛔️ Could not connect to RabbitMQ after multiple attempts");
}

async function main() {
  //  EXPRESS + SOCKET.IO SETUP
  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server);

  app.use(bodyParser.urlencoded({ extended: true }));
  app.set("views", path.join(__dirname, "views"));
  app.set("view engine", "ejs");
  app.use("/css", express.static(path.join(__dirname, "public/css")));

  // REDIS PUB/SUB FOR LIVE UPDATES
  const redisSub = createClient({ url: REDIS_URL });
  const redisPub = createClient({ url: REDIS_URL });
  await redisSub.connect();
  await redisPub.connect();

  await redisSub.subscribe("task_updates", (msg) => {
    io.emit("task_update", JSON.parse(msg));
  });

  //  RABBITMQ SETUP
  const conn = await connectRabbitWithRetry(RABBIT_URL);
  const ch = await conn.createChannel();

  // dead-letter exchange / queue
  await ch.assertExchange(DLX, "fanout", { durable: true });
  await ch.assertQueue(DLQ, { durable: true });
  await ch.bindQueue(DLQ, DLX, "");

  // main work queue
  await ch.assertQueue(QUEUE, {
    durable: true,
    arguments: { "x-dead-letter-exchange": DLX },
  });

  //  ROUTES
  app.get("/", (_req, res) => {
    // kick the page off with no flashes, no inline results
    res.render("index", {
      flash: [],
      reverseResult: null,
      sentimentResult: null,
    });
  });

  app.post("/", async (req, res) => {
    const { form_type } = req.body;
    const valid = [
      "send_email_task",
      "reverse_text_task",
      "fake_sentiment_analysis",
    ];
    if (!valid.includes(form_type)) {
      return res.render("index", {
        flash: [{ type: "danger", msg: "Unknown form submitted" }],
        reverseResult: null,
        sentimentResult: null,
      });
    }

    // 1) create a new task ID + store pending metadata in Redis
    const id = uuidv4();
    const payload =
      form_type === "send_email_task"
        ? {
            recipient: req.body.recipient,
            subject: req.body.subject,
            body: req.body.body,
          }
        : { text: req.body.text };

    await redisPub.hSet(`task:${id}`, {
      type: form_type,
      status: "pending",
      payload: JSON.stringify(payload),
    });

    // 2) fire a “pending” update onto our pub/sub channel
    await redisPub.publish(
      "task_updates",
      JSON.stringify({
        id,
        status: "pending",
        type: form_type,
        timestamp: Date.now(),
        workerPid: null,
      })
    );

    // 3) enqueue the job
    ch.sendToQueue(
      QUEUE,
      Buffer.from(JSON.stringify({ id, type: form_type, payload })),
      { persistent: true }
    );

    // 4) if it’s one of the quick tasks, poll Redis for up to 10s
    let reverseResult = null;
    let sentimentResult = null;

    if (
      form_type === "reverse_text_task" ||
      form_type === "fake_sentiment_analysis"
    ) {
      const key = `task:${id}`;
      let doneVal = null;

      for (let i = 0; i < 20; i++) {
        const st = await redisPub.hGet(key, "status");
        if (st === "completed" || st === "failed") {
          const raw = await redisPub.hGet(key, "result");
          doneVal = JSON.parse(raw);
          break;
        }
        await sleep(500);
      }

      if (form_type === "reverse_text_task") reverseResult = doneVal;
      if (form_type === "fake_sentiment_analysis") sentimentResult = doneVal;
    }

    // 5) render with a success flash + inline result if any
    res.render("index", {
      flash: [
        {
          type: "success",
          msg: `Task queued (ID=${id}).  Monitor Task via Redis Commander....`,
        },
      ],
      reverseResult,
      sentimentResult,
    });
  });

  // START HTTP + WS
  server.listen(5000, "0.0.0.0", () =>
    console.log("🚀 Listening on http://localhost:5000")
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
